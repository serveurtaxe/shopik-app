/**
 * Backfill: normalize stored `Product.gs1` to the pruned shape.
 *
 * enrich used to copy supplier payload sections verbatim into Product.gs1
 * (empty strings, `[{value:'',code:''}]` arrays, whole blank sections), and
 * three nested-literal spots additionally left dangling values behind:
 * `ids.manufacturer: {}`, `allergens.mayContain: []` and
 * `nutrition.additional: null` (the last on ~8.5k products). mapGs1ToProduct
 * now produces the pruned shape, so every future enrich writes it — this
 * rewrites what's already stored.
 *
 * Only `gs1` is touched. The mapped scalars (name, kashrut, nutrients, …)
 * are byte-identical between the old and new mapper for the same payload
 * (proven over the full gs1_products collection), so they are already
 * correct — and admins may have edited them since enrich ran.
 *
 * Source of truth per product, in order:
 *   1. gs1_products by Product.gs1ProductCode (stored pointer from enrich),
 *   2. gs1_products by exact barcode (GTIN === product barcode),
 *   3. reverse-alias: product short uniquely derivable from a GTIN
 *      (same uniqueness rule enrich uses; ambiguous → skipped + counted).
 * Products with no source raw are pruned in place — provably identical to a
 * fresh re-map (pruneEmpty(oldGs1) === newGs1). A product whose recomputed
 * gs1 is empty gets `$unset` instead of a degenerate subdoc.
 *
 * Usage: node server/scripts/runNormalizeProductGs1.js [--dry-run]
 *          [--limit N] [--page N]
 */
import { mapGs1ToProduct } from '#server/external/gs1/mapper.js'
import { pruneEmpty } from '#server/external/gs1/prune.js'
import {
    aliasCandidates, aliasEnabled, aliasMinLen
} from '#server/services/gs1/alias.js'

const DEFAULT_PAGE = 200

const bytes = v => {
    try {
        return Buffer.byteLength(JSON.stringify(v ?? null))
    } catch {
        return 0
    }
}
const stable = v => JSON.stringify(v ?? null)

export default async function normalizeProductGs1(
    { DL } = {},
    { dryRun = false, limit = 0, page = DEFAULT_PAGE } = {}
) {
    if (!DL?.Product?.Model || !DL?.Gs1Product) throw new Error('DL required')
    const cap = Number(limit) || 0
    const pageSize = Math.max(1, Number(page) || DEFAULT_PAGE)
    const Product = DL.Product.Model

    // Join data, loaded once: 14k tiny docs. productCode is the stored
    // pointer enrich left behind; barcode is the GTIN for exact matches.
    const raws = await DL.Gs1Product.read(
        {}, { _id: 0, barcode: 1, productCode: 1 }, { limit: 0 }
    )
    const byProductCode = new Map()
    const byBarcode = new Map()
    for (const r of raws || []) {
        if (r?.productCode && !byProductCode.has(r.productCode)) byProductCode.set(r.productCode, r.barcode)
        if (r?.barcode && !byBarcode.has(r.barcode)) byBarcode.set(r.barcode, r.barcode)
    }
    // Reverse-alias: short candidate -> GTINs. Mirrors enrich's uniqueness
    // rule — a short matching 2+ GTINs resolves to nothing.
    const aliasToGtins = new Map()
    if (aliasEnabled()) {
        const minLen = aliasMinLen()
        for (const gtin of byBarcode.keys()) {
            for (const c of aliasCandidates(gtin, minLen)) {
                if (!aliasToGtins.has(c)) aliasToGtins.set(c, [])
                aliasToGtins.get(c).push(gtin)
            }
        }
    }
    const resolveGtin = product => {
        if (product?.gs1ProductCode && byProductCode.has(product.gs1ProductCode))
            return { gtin: byProductCode.get(product.gs1ProductCode), via: 'productCode' }
        if (product?.barcode && byBarcode.has(product.barcode))
            return { gtin: product.barcode, via: 'exact' }
        if (aliasEnabled() && product?.barcode) {
            const gtins = aliasToGtins.get(product.barcode) || []
            if (gtins.length === 1) return { gtin: gtins[0], via: 'alias' }
            if (gtins.length > 1) return { ambiguous: true }
        }
        return {}
    }

    const totals = {
        scanned: 0, resolved: 0, orphan: 0, ambiguous: 0, mapError: 0,
        changed: 0, written: 0, unset: 0, identical: 0, drift: 0,
        bytesBefore: 0, bytesAfter: 0
    }

    console.log(`[normalizeGs1] scanning products with gs1${dryRun ? ' (DRY RUN — no writes)' : ''}`)
    // NOTE: DL.read can't express this filter — processFilter drops any key
    // outside filterFields and strips $exists — so Model.find is used
    // directly. Paging is by _id RANGE, not skip: $unset removes docs from
    // this filtered set, shifting everything left, so skip would leap over
    // shifted docs and never visit them. (A range scan visits each doc
    // exactly once; only a product gaining gs1 behind the cursor — a
    // concurrent enrich of an old product — waits for the next run.)
    let lastId = null
    for (;;) {
        const filter = lastId
            ? { gs1: { $exists: true }, _id: { $gt: lastId } }
            : { gs1: { $exists: true } }
        const products = await Product.find(
            filter,
            { _id: 1, barcode: 1, gs1: 1, gs1ProductCode: 1 }
        ).sort({ _id: 1 }).limit(pageSize).lean()
        if (!products?.length) break

        // Source raws for this page's resolved GTINs, in one bulk read.
        const wantGtins = new Map() // gtin -> product(s)
        for (const p of products) {
            if (cap && totals.scanned >= cap) break
            const r = resolveGtin(p)
            if (r.ambiguous) { totals.ambiguous++; continue }
            if (!r.gtin) continue
            if (!wantGtins.has(r.gtin)) wantGtins.set(r.gtin, [])
            wantGtins.get(r.gtin).push({ product: p, via: r.via })
        }
        const rawDocs = wantGtins.size ? await DL.Gs1Product.read(
            { barcode: { $in: [...wantGtins.keys()] } },
            { _id: 0, barcode: 1, raw: 1 },
            { limit: 0 }
        ) : []
        const rawByGtin = new Map((rawDocs || []).map(d => [d?.barcode, d?.raw]))

        const sets = []
        const unsets = []
        for (const p of products) {
            if (cap && totals.scanned >= cap) break
            totals.scanned++
            const cur = p.gs1
            if (cur == null) continue
            const r = resolveGtin(p)
            if (r.ambiguous) continue // already counted
            const via = r.gtin ? (r.via || '?') : 'orphan'
            let next
            let orphan = false
            if (r.gtin && rawByGtin.has(r.gtin) && rawByGtin.get(r.gtin) != null) {
                totals.resolved++
                try {
                    next = mapGs1ToProduct(rawByGtin.get(r.gtin)).doc.gs1
                } catch {
                    totals.mapError++
                    continue
                }
            } else {
                // No source raw: prune the stored subdoc in place. Equivalent
                // to a fresh re-map (pruneEmpty(oldGs1) === newGs1, proven).
                totals.orphan++
                orphan = true
                next = pruneEmpty(JSON.parse(JSON.stringify(cur))) || {}
                if (!Object.keys(next).length) next = undefined
            }
            if (stable(cur) === stable(next ?? null)) { totals.identical++; continue }
            totals.changed++
            // Drift, not just blanks: the source raw changed since this
            // product was enriched (e.g. supplier corrected a value).
            // Writing the fresh map heals it; counted separately so the
            // operator can see content changes vs pure blank-stripping.
            if (!orphan && stable(pruneEmpty(JSON.parse(JSON.stringify(cur))) ?? null) !== stable(next ?? null)) {
                totals.drift++
                if (totals.drift <= 5) console.log(`[normalizeGs1] drift ${p.barcode} (via ${via}) — stored gs1 differs beyond blanks`)
            }
            totals.bytesBefore += bytes(cur)
            totals.bytesAfter += bytes(next ?? null)
            if (next === undefined) unsets.push({ barcode: p.barcode })
            else sets.push({ barcode: p.barcode, gs1: next })
        }

        if (!dryRun) {
            if (sets.length) {
                await DL.Product.bulkWrite({
                    docs: sets,
                    getFilter: d => ({ barcode: d.barcode }),
                    getUpsert: () => false,
                    // $set only `gs1` — never the whole doc, or we'd clobber
                    // admin edits to name/description/prices.
                    getUpdate: d => ({ $set: { gs1: d.gs1 } })
                })
            }
            if (unsets.length) {
                await DL.Product.bulkWrite({
                    docs: unsets,
                    getFilter: d => ({ barcode: d.barcode }),
                    getUpsert: () => false,
                    getUpdate: () => ({ $unset: { gs1: '' } })
                })
            }
        }
        totals.written += sets.length + unsets.length
        totals.unset += unsets.length

        lastId = products[products.length - 1]._id
        if (cap && totals.scanned >= cap) break
        if (totals.scanned % 2000 < pageSize)
            console.log(`[normalizeGs1] ${totals.scanned} scanned, ${totals.changed} need normalizing...`)
    }

    const saved = totals.bytesBefore - totals.bytesAfter
    const pct = totals.bytesBefore ? ((saved / totals.bytesBefore) * 100).toFixed(1) : '0.0'
    console.log(
        `[normalizeGs1] done: scanned=${totals.scanned} resolved=${totals.resolved} ` +
        `orphan=${totals.orphan} ambiguous=${totals.ambiguous} mapError=${totals.mapError}`
    )
    console.log(
        `[normalizeGs1] changed=${totals.changed} written=${totals.written} ` +
        `unset=${totals.unset} identical=${totals.identical} drift=${totals.drift}`
    )
    console.log(
        `[normalizeGs1] gs1 payload ${(totals.bytesBefore / 1024).toFixed(1)} KB -> ` +
        `${(totals.bytesAfter / 1024).toFixed(1)} KB (saved ${(saved / 1024).toFixed(1)} KB, ${pct}%)`
    )
    console.log('[normalizeGs1] note: sizes are JSON bytes; BSON adds per-key overhead, so the real ratio differs.')
    return totals
}