/**
 * Backfill: strip blank values out of stored `raw` payloads.
 *
 * mapGs1ToProduct prunes empties before storing (see external/gs1/prune.js),
 * but the freshness gate in workers/gs1FetchWorker.js skips re-storing a
 * product whose modificationTime + fingerprint are unchanged — so existing
 * docs would keep their ~25% of empty strings forever. This rewrites them in
 * place. Consumers already treat a missing key as empty, so the mapped
 * Product/gs1 data is unaffected.
 *
 * Only `raw` is touched: status, skipReason, fingerprint, syncedAt and
 * modificationTime are deliberately left alone so the pipeline doesn't
 * re-count or re-process anything. `updatedAt` moves (mongoose timestamps),
 * which is the honest signal that the payload was normalised.
 *
 * $set on a Mixed field replaces the whole subdocument, so removed keys are
 * gone without a per-key $unset.
 *
 * Freed space is reused by WiredTiger immediately, but the collection file
 * only shrinks after a compact — hence --compact.
 *
 * Usage: node server/scripts/runPruneGs1Raw.js [--dry-run] [--limit N]
 *          [--page N] [--compact]
 */
import { pruneEmpty } from '#server/external/gs1/prune.js'

const DEFAULT_PAGE = 200

const bytes = v => {
    try {
        return Buffer.byteLength(JSON.stringify(v ?? null))
    } catch {
        return 0
    }
}

export default async function pruneGs1Raw(
    { DL } = {},
    { dryRun = false, limit = 0, page = DEFAULT_PAGE, compact = false } = {}
) {
    if (!DL?.Gs1Product) throw new Error('DL required')
    const cap = Number(limit) || 0
    const pageSize = Math.max(1, Number(page) || DEFAULT_PAGE)

    const totals = {
        scanned: 0, changed: 0, written: 0,
        bytesBefore: 0, bytesAfter: 0,
        noRaw: 0, prunedToNothing: 0, failed: 0
    }

    console.log(`[pruneGs1Raw] scanning gs1_products${dryRun ? ' (DRY RUN — no writes)' : ''}`)
    // Paging by _id is stable across the run: we only $set `raw` on existing
    // docs, never insert/delete or touch the sort key.
    for (let skip = 0; ; skip += pageSize) {
        const docs = await DL.Gs1Product.read(
            {},
            { _id: 1, barcode: 1, raw: 1 },
            { skip, limit: pageSize, sort: { _id: 1 } }
        )
        if (!docs?.length) break

        const updates = []
        for (const doc of docs) {
            if (cap && totals.scanned >= cap) break
            totals.scanned++
            if (doc.raw == null) {
                totals.noRaw++
                continue
            }
            const pruned = pruneEmpty(doc.raw) || {}
            if (JSON.stringify(pruned) === JSON.stringify(doc.raw)) continue
            totals.changed++
            totals.prunedToNothing += Object.keys(pruned).length ? 0 : 1
            totals.bytesBefore += bytes(doc.raw)
            totals.bytesAfter += bytes(pruned)
            updates.push({ barcode: doc.barcode, raw: pruned })
        }

        if (updates.length) {
            if (dryRun) {
                totals.written += updates.length
            } else {
                const res = await DL.Gs1Product.bulkWrite({
                    docs: updates,
                    getFilter: d => ({ barcode: d.barcode }),
                    getUpsert: () => false,
                    // $set only `raw` — never the whole doc, or we'd clobber
                    // status/skipReason and make the pipeline reprocess.
                    getUpdate: d => ({ $set: { raw: d.raw } })
                })
                if (res?.modifiedCount != null && res.modifiedCount < updates.length) {
                    console.log(`[pruneGs1Raw]   page: modified ${res.modifiedCount}/${updates.length} (some docs vanished mid-run?)`)
                }
                totals.written += updates.length
            }
        }

        if (cap && totals.scanned >= cap) break
        if (docs.length < pageSize) break
        if (totals.scanned % 2000 < pageSize)
            console.log(`[pruneGs1Raw] ${totals.scanned} scanned, ${totals.changed} need pruning...`)
    }

    const saved = totals.bytesBefore - totals.bytesAfter
    const pct = totals.bytesBefore ? ((saved / totals.bytesBefore) * 100).toFixed(1) : '0.0'
    console.log(
        `[pruneGs1Raw] done: scanned=${totals.scanned} changed=${totals.changed} ` +
        `written=${totals.written} noRaw=${totals.noRaw} emptyAfter=${totals.prunedToNothing} failed=${totals.failed}`
    )
    console.log(
        `[pruneGs1Raw] raw payload ${(totals.bytesBefore / 1024).toFixed(1)} KB -> ` +
        `${(totals.bytesAfter / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB, ${pct}%)`
    )
    console.log('[pruneGs1Raw] note: sizes are JSON bytes; BSON adds per-key overhead, so the real ratio differs.')

    if (compact) {
        if (dryRun) {
            console.log('[pruneGs1Raw] --compact ignored in dry-run.')
        } else {
            await compactCollection(DL)
        }
    } else if (!dryRun) {
        console.log('[pruneGs1Raw] run again with --compact to shrink the collection file on disk.')
    }

    return totals
}

// WiredTiger already reuses the pages the prune freed, so the collection's
// logical size is down whether or not this runs — compact only returns the
// space to the filesystem. The app's Atlas role usually can't run it (needs
// the `compact` action on `admin`), so a failure here is a privilege problem,
// not a failed prune: warn and exit 0 rather than crashing a run that worked.
async function compactCollection(DL) {
    const Model = DL.Gs1Product.Model
    const collection = Model.collection.collectionName || Model.collection.name
    console.log(`[pruneGs1Raw] compacting ${collection} (needs free disk ≈ collection size)...`)
    // Model.db is the mongoose Connection; .db on it is the native Db.
    try {
        const res = await Model.db.db.admin().command({ compact: collection })
        console.log('[pruneGs1Raw] compact result:', JSON.stringify(res))
    } catch (e) {
        const msg = e?.message || String(e)
        console.warn(`[pruneGs1Raw] COMPACT FAILED: ${msg.split('\n')[0]}`)
        console.warn('[pruneGs1Raw] The prune above completed — only the on-disk reclaim was skipped.')
        console.warn('[pruneGs1Raw] Space freed by the prune is already reusable; compact is cosmetic.')
        if (/Unauthorized|not authorized/i.test(msg)) {
            console.warn('[pruneGs1Raw] The app Atlas role lacks `compact` on `admin`. Run it with an admin user instead:')
            console.warn(`[pruneGs1Raw]   mongosh "<admin-uri>" --eval 'db.runCommand({compact:"${collection}"})'`)
            console.warn('[pruneGs1Raw] Shared/free Atlas tiers may not permit compact at all.')
        }
        return false
    }
    return true
}