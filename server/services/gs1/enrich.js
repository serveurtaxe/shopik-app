import pLimit from 'p-limit'
import { enqueueProcessJobs } from '#server/queues/gs1Queues.js'
import { bufferProduct, bufferRaw, bufferProgress, flush } from './bulk.js'
import { stageZip, buildFingerprint, hashFingerprint, countStills, rankStills, bucketHasImage, buildImageSizes, isZipBuffer, zipEntryBasenames, baseName, imageExtFromMagic, wrapSingleImage } from './images.js'
import { mem } from './memlog.js'
import { aliasCandidates, aliasEnabled, resolveAlias, aliasMinLen } from './alias.js'
import log from '#server/utils/log.js'

const enrichBatchSize = () => Number(process.env.GS1_ENRICH_BATCH || 500)
const imageBatchSize = () => Number(process.env.GS1_IMAGE_BATCH || 200)
const zipConcurrency = () => Number(process.env.GS1_ZIP_CONCURRENCY || 2)
// GS1 files-endpoint image types (per supplier doc): EL = 360° spin set,
// PL = planogram, HE = hero, MK = market images. Observed: HE returns the
// single raw hero bytes (not a zip — wrapped by the fetcher); EL is the
// multi-MB bloat (nested 40-frame container) we never request. Values are
// uppercased to the doc's spelling; genuinely unknown values get HTTP 200 +
// "invalid media type" while known-but-empty ones 404 (both safely skipped).
const mediaTypes = () => String(process.env.GS1_MEDIA_TYPES || 'MK,HE')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)

// Fetch the smallest usable source: try each configured type= filter first,
// stage the first usable response, else fall back to media=all (today's
// behavior, caps intact). A hit is either a zip containing our main still
// or a single raw image (HE returns the hero bytes unarchived — wrapped
// into a one-entry zip, main only). Per-attempt results are logged — that
// output is the EL/PL/HE/MK mapping proof per product.
// Returns { buffer, via } or null when nothing usable came back.
// rateLimited/transient errors throw (caller retries the batch); anything
// else on a type= attempt just moves to the next candidate.
async function fetchStagedSource(external, barcode, wantedMain) {
    if (wantedMain) {
        for (const t of mediaTypes()) {
            let buf = null
            try {
                buf = await external.gs1.getMediaZip(barcode, { type: t })
            } catch (e) {
                if (e?.rateLimited || e?.transient) throw e
                log.warn(`[GS1] type=${t} fetch failed for ${barcode}:`, e?.message || e)
                continue
            }
            if (!isZipBuffer(buf)) {
                const wrapped = wrapSingleImage(buf, wantedMain)
                if (wrapped) {
                    log.info(`[GS1] type=${t} for ${barcode}: single image (${buf.length} bytes), wrapped as ${wrapped.name}`)
                    return { buffer: wrapped.buffer, via: `type=${t} (single)` }
                }
                log.info(`[GS1] type=${t} for ${barcode}: not a zip (${buf?.length || 0} bytes), skipping`)
                continue
            }
            const names = zipEntryBasenames(buf)
            if (names?.has(wantedMain)) {
                log.info(`[GS1] type=${t} for ${barcode}: ${buf.length} bytes, main present (${names.size} entries)`)
                return { buffer: buf, via: `type=${t}` }
            }
            log.info(`[GS1] type=${t} for ${barcode}: ${buf.length} bytes but main missing, skipping`)
        }
    }
    const buf = await external.gs1.getMediaZip(barcode)
    if (!buf?.length) return null
    return { buffer: buf, via: 'media=all' }
}

// Phase 2: enrich products from the local gs1_products collection.
// Two-pass to bound memory: page barcode-only docs, gate in bulk, then load
// full raws ONLY for passers. No GS1 calls, no per-doc writes, no images.
// afterBarcode: cursor for paging. force runs filter on nothing (every status
// qualifies), so without a cursor the same first page is returned forever and
// runEnrich loops indefinitely. barcode is unique + filterable, so the range +
// sort is index-backed and each batch advances strictly forward.
export async function enrichBatch({ DL, external, runId, onlyInStock = true, barcode = '', force = false, afterBarcode = '' }) {
    const filter = {}
    if (barcode) filter.barcode = barcode
    else if (afterBarcode) filter.barcode = { $gt: afterBarcode }
    if (!force) filter.status = 'fetched'
    const page = await DL.Gs1Product.read(
        filter,
        { _id: 0, barcode: 1 },
        { limit: enrichBatchSize(), sort: { barcode: 1 } }
    )
    if (!page?.length) return { done: true, enriched: 0, skipped: 0, total: 0, next: null }

    const barcodes = [...new Set(page.map(r => r?.barcode).filter(Boolean))]
    const products = await DL.Product.read(
        { barcode: { $in: barcodes } },
        { _id: 0, barcode: 1, storeIds: 1 },
        { limit: 0 }
    )
    const productSet = new Set((products || []).map(p => p.barcode))
    const inStockSet = new Set((products || []).filter(p => (p.storeIds || []).length).map(p => p.barcode))

    let enriched = 0
    let skipped = 0
    // passing entries are { gtin, short }: gtin keys the gs1_products raw doc,
    // short keys the Product write. Exact matches have gtin === short.
    const passing = []
    const unmatched = []
    for (const barcode of barcodes) {
        if (!productSet.has(barcode)) {
            unmatched.push(barcode)
            continue
        }
        const reason = (onlyInStock && !inStockSet.has(barcode)) ? 'out-of-stock' : null
        if (reason) {
            bufferRaw({ barcode, status: 'skipped', skipReason: reason })
            skipped++
        } else {
            passing.push({ gtin: barcode, short: barcode })
        }
    }

    // Alias fallback: GTINs with no exact Product match resolve to a short
    // internal code (prefix + zeros + short). Product-only gate — no Comax
    // check. Ambiguous GTINs (2+ distinct shorts) are skipped, never guessed.
    if (unmatched.length && aliasEnabled()) {
        const minLen = aliasMinLen()
        const candidates = new Set()
        for (const g of unmatched)
            for (const c of aliasCandidates(g, minLen)) candidates.add(c)
        const foundSet = new Set()
        if (candidates.size) {
            const aliasProducts = await DL.Product.read(
                { barcode: { $in: [...candidates] } },
                { _id: 0, barcode: 1, storeIds: 1 },
                { limit: 0 }
            )
            for (const p of aliasProducts || []) {
                if (!p?.barcode) continue
                foundSet.add(p.barcode)
                if ((p.storeIds || []).length) inStockSet.add(p.barcode)
            }
        }
        for (const g of unmatched) {
            const r = resolveAlias(g, foundSet, minLen)
            if (r?.short) {
                if (onlyInStock && !inStockSet.has(r.short)) {
                    bufferRaw({ barcode: g, status: 'skipped', skipReason: 'out-of-stock' })
                    skipped++
                } else {
                    passing.push({ gtin: g, short: r.short })
                    log.info(`[GS1] Alias ${g} → ${r.short}`)
                }
            } else if (r?.ambiguous) {
                bufferRaw({ barcode: g, status: 'skipped', skipReason: 'alias-ambiguous' })
                log.warn(`[GS1] Ambiguous alias ${g} matches: ${r.ambiguous.join(',')} — skipped`)
                skipped++
            } else {
                bufferRaw({ barcode: g, status: 'skipped', skipReason: 'no-product' })
                skipped++
            }
        }
    } else {
        for (const g of unmatched) {
            bufferRaw({ barcode: g, status: 'skipped', skipReason: 'no-product' })
            skipped++
        }
    }

    if (passing.length) {
        const full = await DL.Gs1Product.read(
            { barcode: { $in: passing.map(p => p.gtin) } },
            { _id: 0, barcode: 1, raw: 1 },
            { limit: 0 }
        )
        const fullByBarcode = new Map((full || []).map(r => [r?.barcode, r]))
        for (const { gtin: barcode, short } of passing) {
            const stored = fullByBarcode.get(barcode)
            if (!stored?.raw) {
                bufferRaw({ barcode, status: 'skipped', skipReason: 'empty-raw' })
                skipped++
                continue
            }
            let mapped
            try {
                mapped = external.gs1.mapGs1ToProduct(stored.raw)
            } catch (e) {
                bufferRaw({ barcode, status: 'skipped', skipReason: `map-error: ${e?.message || e}` })
                skipped++
                continue
            }
            // Alias writes MUST override doc.barcode: bulkWrite $sets the whole
            // doc, so a GTIN left in mapped.doc would rewrite Product.barcode
            // (or upsert a duplicate product under the GTIN).
            const doc = { ...mapped.doc, barcode: short }
            // Supplier removed/unchecked images → clear local images (status untouched).
            if (mapped.removal.deleted || mapped.removal.unchecked) {
                bufferProduct(short, { ...doc, 'images.product': [] })
                log.warn(`[GS1] Images cleared for ${barcode} (supplier removal flag)`)
            } else {
                bufferProduct(short, doc)
            }
            bufferRaw({ barcode, status: 'enriched' })
            enriched++
        }
    }

    bufferProgress(runId, { processed: page.length })
    await flush()
    mem(`enrich-batch done=${enriched + skipped} enriched=${enriched}`)
    const next = [...page].reverse().find(r => r?.barcode)?.barcode || null
    return { done: false, enriched, skipped, total: page.length, next }
}

export async function runEnrich(opts) {
    const totals = { enriched: 0, skipped: 0, batches: 0, rescued: 0 }
    // Rescue pass first: products created (or restocked) after a skip stay
    // 'skipped' forever because enrich only pages status:'fetched'.
    try {
        totals.rescued = await requeueRescued(opts)
    } catch (e) {
        log.warn('[GS1] Rescue pass failed (continuing enrich):', e?.message || e)
    }
    let after = ''
    for (; ;) {
        const res = await enrichBatch({ ...opts, afterBarcode: after })
        totals.enriched += res.enriched
        totals.skipped += res.skipped
        totals.batches++
        if (res.done) break
        // Single-barcode mode: one batch is the whole job.
        if (opts?.barcode) break
        // A batch with no usable barcode can't advance the cursor — stop rather
        // than re-read the same page forever.
        if (!res.next || res.next === after) break
        after = res.next
    }
    await flush()
    log.success(`[GS1] Enrich done: ${totals.enriched} enriched, ${totals.skipped} skipped, ${totals.batches} batches, ${totals.rescued} rescued`)
    return totals
}

// Pre-pass for runEnrich: flip previously-skipped docs whose gate now passes
// back to 'fetched' (skipReason is cleared by the bulk flusher) so the normal
// flow picks them up. Covers catalog churn (product created after the skip)
// and restocks (out-of-stock skip, now in stock — or a false-run following a
// true-run). map-error/empty-raw are NOT rescuable by enrich alone.
const RESCUABLE_REASONS = ['no-product', 'no-comax', 'out-of-stock', 'alias-ambiguous']
export async function requeueRescued({ DL, onlyInStock = true, barcode = '' }) {
    const match = barcode
        ? { status: 'skipped', skipReason: { $in: RESCUABLE_REASONS }, barcode }
        : { status: 'skipped', skipReason: { $in: RESCUABLE_REASONS } }
    const candidates = await DL.Gs1Product.read(
        match,
        { _id: 0, barcode: 1 },
        { limit: 0 }
    )
    const barcodes = [...new Set((candidates || []).map(r => r?.barcode).filter(Boolean))]
    if (!barcodes.length) return 0

    const products = await DL.Product.read(
        { barcode: { $in: barcodes } },
        { _id: 0, barcode: 1, storeIds: 1 },
        { limit: 0 }
    )
    const productSet = new Set((products || []).map(p => p.barcode))
    const inStockSet = new Set((products || []).filter(p => (p.storeIds || []).length).map(p => p.barcode))

    // Alias fallback for GTINs with no exact Product match: product-only gate,
    // same rule as enrichBatch. Ambiguous GTINs stay skipped.
    const aliasShortByGtin = new Map()
    const unmatched = barcodes.filter(b => !productSet.has(b))
    if (unmatched.length && aliasEnabled()) {
        const minLen = aliasMinLen()
        const candidates = new Set()
        for (const g of unmatched)
            for (const c of aliasCandidates(g, minLen)) candidates.add(c)
        if (candidates.size) {
            const aliasProducts = await DL.Product.read(
                { barcode: { $in: [...candidates] } },
                { _id: 0, barcode: 1, storeIds: 1 },
                { limit: 0 }
            )
            const foundSet = new Set()
            for (const p of aliasProducts || []) {
                if (!p?.barcode) continue
                foundSet.add(p.barcode)
                if ((p.storeIds || []).length) inStockSet.add(p.barcode)
            }
            for (const g of unmatched) {
                const r = resolveAlias(g, foundSet, minLen)
                if (r?.short) aliasShortByGtin.set(g, r.short)
            }
        }
    }

    let rescued = 0
    for (const b of barcodes) {
        const aliasShort = aliasShortByGtin.get(b)
        if (aliasShort) {
            if (onlyInStock && !inStockSet.has(aliasShort)) continue
            bufferRaw({ barcode: b, status: 'fetched' })
            rescued++
            continue
        }
        if (!productSet.has(b)) continue
        if (onlyInStock && !inStockSet.has(b)) continue
        bufferRaw({ barcode: b, status: 'fetched' })
        rescued++
    }
    if (rescued) {
        await flush()
        log.info(`[GS1] Rescued ${rescued} previously-skipped docs back to fetched`)
    }
    return rescued
}

// Phase 3 launcher: download zips (bounded concurrency), stage to GCS,
// enqueue CPU process jobs. Reads enriched raws; skips imageless/removed.
// force: reprocess even when imagesDone or the main fingerprint matches
// (needed to backfill alternates onto pre-alternates mains).
// limit: max raw docs to take this call (0 = all) — keeps single HTTP calls
// inside Cloud Run request timeouts; repeat until queued=0.
export async function runImages({ DL, external, runId, force = false, limit = 0, barcode = '' }) {
    const cap = Number(limit || process.env.GS1_IMAGE_LIMIT || 0)
    const limitZip = pLimit(zipConcurrency())
    const totals = { queued: 0, noZip: 0, skipped: 0, reused: 0 }
    let taken = 0
    // Barcodes already handled this call. The loop pages the collection, but
    // a still-eligible doc (force runs ignore imagesDone; a queued doc's
    // worker hasn't marked it yet) would otherwise be staged + re-queued on
    // EVERY batch — the taken=1..N infinite loop. Each barcode is handled
    // once per call; cross-call repeats still work via imageLimit batching.
    const seen = new Set()
    for (; ;) {
        if (cap && taken >= cap) break
        const baseFilter = barcode
            ? { status: 'enriched', barcode }
            : { status: 'enriched' }
        const raws = await DL.Gs1Product.read(
            force ? { ...baseFilter, assetCount: { $gt: 0 } }
                : { ...baseFilter, assetCount: { $gt: 0 }, imagesDone: { $ne: true } },
            { _id: 0, barcode: 1, raw: 1 },
            { limit: imageBatchSize() }
        )
        if (!raws?.length) break
        const fresh = raws.filter(r => r?.barcode && !seen.has(r.barcode))
        // Whole batch already handled → no forward progress possible.
        if (!fresh.length) break
        for (const r of fresh) seen.add(r.barcode)

        const barcodes = fresh.map(r => r.barcode)
        const products = await DL.Product.read(
            { barcode: { $in: barcodes } },
            { _id: 0, id: 1, barcode: 1, images: 1 },
            { limit: 0 }
        )
        const productByBarcode = new Map((products || []).map(p => [p.barcode, p]))
        // Alias fallback: enriched-via-alias raws are keyed by GTIN, so the
        // exact lookup above misses — resolve to the short-code product.
        if (aliasEnabled()) {
            const missing = barcodes.filter(b => !productByBarcode.has(b))
            if (missing.length) {
                const minLen = aliasMinLen()
                const candidates = new Set()
                for (const g of missing)
                    for (const c of aliasCandidates(g, minLen)) candidates.add(c)
                if (candidates.size) {
                    const aliasProducts = await DL.Product.read(
                        { barcode: { $in: [...candidates] } },
                        { _id: 0, id: 1, barcode: 1, images: 1 },
                        { limit: 0 }
                    )
                    const foundSet = new Set((aliasProducts || []).map(p => p.barcode))
                    const shortByBarcode = new Map((aliasProducts || []).map(p => [p.barcode, p]))
                    for (const g of missing) {
                        const r = resolveAlias(g, foundSet, minLen)
                        if (r?.short) {
                            productByBarcode.set(g, shortByBarcode.get(r.short))
                            log.info(`[GS1] Alias ${g} → ${r.short} (images)`)
                        }
                    }
                }
            }
        }

        await Promise.all(raws.map(stored => limitZip(async () => {
            const barcode = stored.barcode
            const product = productByBarcode.get(barcode)
            if (!product) {
                bufferRaw({ barcode, status: 'skipped', skipReason: 'no-product-images' })
                totals.skipped++
                return
            }
            let mapped
            try {
                mapped = external.gs1.mapGs1ToProduct(stored.raw)
            } catch {
                bufferRaw({ barcode, status: 'skipped', skipReason: 'map-error-images' })
                totals.skipped++
                return
            }
            if (mapped.removal.deleted || mapped.removal.unchecked) {
                bufferRaw({ barcode, imagesDone: true })
                totals.skipped++
                return
            }
            const fingerprint = hashFingerprint(
                buildFingerprint(barcode, mapped.mediaAssets, mapped.modificationTime))
            const main = (product.images?.product || []).find(i => i?.main)
            const mainMatches = main?.sourceUrl?.startsWith('gs1://') && main?.hash === fingerprint
            // Single-still products gain nothing from reprocessing: with a matching
            // main there are no alternates to backfill (also bounds force runs).
            if (mainMatches && (countStills(mapped.mediaAssets) < 2 || !force)) {
                bufferRaw({ barcode, imagesDone: true })
                return
            }
            // Bucket-first: expected keys already in GCS are reused — no GS1
            // download, no render. Keys/assetIds come from ranked metadata.
            const { main: rankedMain, alternates: rankedAlts } = rankStills(mapped.mediaAssets)
            const ranked = [
                ...(rankedMain ? [{ ...rankedMain, isMain: true }] : []),
                ...rankedAlts.map(r => ({ ...r, isMain: false }))
            ]
            const reuse = {}
            let allPresent = ranked.length > 0
            for (const r of ranked) {
                if (await bucketHasImage(product.id, r.key)) {
                    reuse[r.key] = { assetId: r.asset?.id || null, sizes: buildImageSizes(product.id, r.key) }
                } else {
                    allPresent = false
                }
            }
            if (allPresent) {
                const images = ranked.map(r => ({
                    main: r.isMain,
                    sourceUrl: r.isMain ? `gs1://${barcode}` : `gs1://${barcode}/${r.asset?.id || r.asset?.filename}`,
                    hash: fingerprint,
                    sizes: reuse[r.key].sizes
                }))
                const update = { 'images.product': images, gs1SyncedAt: new Date() }
                if ((product.images?.product || []).length === 0 && product.status === 'hidden')
                    update.status = 'active'
                // Key by the product's own barcode: alias-enriched raws are
                // GTIN-keyed, and writing under the GTIN would upsert a
                // duplicate product. sourceUrls above stay gs1://GTIN.
                bufferProduct(product.barcode, update)
                bufferRaw({ barcode, fingerprint, imagesDone: true })
                totals.reused++
                return
            }
            let zip = null
            let via = ''
            try {
                const res = await fetchStagedSource(external, barcode, baseName(ranked[0]?.asset?.filename || ''))
                zip = res?.buffer || null
                via = res?.via || ''
            } catch (e) {
                if (e?.rateLimited || e?.transient) throw e
                // Over-cap zips would otherwise re-download every run and stay
                // imageless (no imagesDone, no skip marker). Park them as
                // skipped — a force run reprocesses if the supplier shrinks it.
                if (/too large/.test(e?.message || '')) {
                    const bytes = (/(\d+) bytes/.exec(e.message || '') || [])[1] || '?'
                    bufferRaw({ barcode, imagesDone: true, skipReason: `zip-too-large:${bytes}` })
                    log.warn(`[GS1] Zip too large, parked ${barcode} (${bytes} bytes)`)
                    totals.skipped++
                    return
                }
                log.warn(`[GS1] Zip failed for ${barcode}:`, e?.message || e)
                totals.noZip++
                return
            }
            if (!zip) {
                totals.noZip++
                return
            }
            mem(`zip-downloaded gtin=${barcode} via=${via} bytes=${zip.length}`)
            const stagingPath = await stageZip(barcode, zip)
            bufferRaw({ barcode, fingerprint, stagingPath })
            await enqueueProcessJobs([{
                productId: product.id,
                gtin: barcode,
                stagingPath,
                fingerprint,
                productCode: mapped.productCode,
                runId,
                mediaAssets: mapped.mediaAssets,
                reuse
            }])
            totals.queued++
        })))

        bufferProgress(runId, { processed: raws.length })
        await flush()
        taken += raws.length
        mem(`images-batch taken=${taken} queued=${totals.queued} reused=${totals.reused} noZip=${totals.noZip}`)
    }
    await flush()
    log.success(`[GS1] Images launch done: ${totals.queued} queued, ${totals.reused} reused, ${totals.noZip} no-zip, ${totals.skipped} skipped`)
    return totals
}

export default { enrichBatch, runEnrich, runImages, requeueRescued }
