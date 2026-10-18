/**
 * Backfill: re-map stored `Product.kashrut` to the object shape
 * ({ rabbinates: [{ code, name }], supervisionType }).
 *
 * enrich used to write kashrut as a plain string ("<food category> / <rabbinate>").
 * mapKashrut (server/external/gs1/mapper.js) now emits an object carrying the
 * GS1 rabbinate codes — which drive stamp ranking and images — plus the
 * supervision (food-category) code. This rewrites what's already stored.
 *
 * Only `kashrut` is touched. Products with no source raw are left untouched:
 * their legacy string is ignored by the UI, which only understands the object
 * shape (see common/components/Kashrut/constants.js).
 *
 * Source of truth per product, in order:
 *   1. gs1_products by Product.gs1ProductCode (stored pointer from enrich),
 *   2. gs1_products by exact barcode (GTIN === product barcode),
 *   3. reverse-alias: product short uniquely derivable from a GTIN.
 *
 * Usage: node server/scripts/runBackfillProductKashrut.js [--dry-run]
 *          [--limit N] [--page N]
 */
import { mapKashrut } from '#server/external/gs1/mapper.js'
import { aliasCandidates, aliasEnabled, aliasMinLen } from '#server/services/gs1/alias.js'

const DEFAULT_PAGE = 200

const stable = v => JSON.stringify(v ?? null)

export default async function backfillProductKashrut(
    { DL } = {},
    { dryRun = false, limit = 0, page = DEFAULT_PAGE } = {}
) {
    if (!DL?.Product?.Model || !DL?.Gs1Product) throw new Error('DL required')
    const cap = Number(limit) || 0
    const pageSize = Math.max(1, Number(page) || DEFAULT_PAGE)
    const Product = DL.Product.Model

    // Join data, loaded once: tiny docs. productCode is enrich's stored pointer.
    const raws = await DL.Gs1Product.read(
        {}, { _id: 0, barcode: 1, productCode: 1 }, { limit: 0 }
    )
    const byProductCode = new Map()
    const byBarcode = new Map()
    for (const r of raws || []) {
        if (r?.productCode && !byProductCode.has(r.productCode)) byProductCode.set(r.productCode, r.barcode)
        if (r?.barcode) byBarcode.set(r.barcode, r.barcode)
    }
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
        }
        return {}
    }

    const totals = {
        scanned: 0, resolved: 0, orphan: 0, mapError: 0,
        changed: 0, written: 0, unset: 0, identical: 0, legacyString: 0
    }

    console.log(`[backfillKashrut] scanning products with kashrut${dryRun ? ' (DRY RUN — no writes)' : ''}`)
    let lastId = null
    for (; ;) {
        const filter = lastId
            ? { kashrut: { $exists: true }, _id: { $gt: lastId } }
            : { kashrut: { $exists: true } }
        const products = await Product.find(
            filter,
            { _id: 1, barcode: 1, kashrut: 1, gs1ProductCode: 1 }
        ).sort({ _id: 1 }).limit(pageSize).lean()
        if (!products?.length) break

        const wantGtins = new Map()
        for (const p of products) {
            if (cap && totals.scanned >= cap) break
            const r = resolveGtin(p)
            if (!r.gtin) continue
            if (!wantGtins.has(r.gtin)) wantGtins.set(r.gtin, [])
            wantGtins.get(r.gtin).push(p)
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
            const cur = p.kashrut
            if (typeof cur === 'string') totals.legacyString++
            const r = resolveGtin(p)
            if (!r.gtin || !rawByGtin.has(r.gtin) || rawByGtin.get(r.gtin) == null) {
                totals.orphan++
                continue
            }
            totals.resolved++
            let next
            try {
                next = mapKashrut(rawByGtin.get(r.gtin)?.product_info?.Kashrut).kashrut
            } catch {
                totals.mapError++
                continue
            }
            if (stable(cur) === stable(next ?? null)) { totals.identical++; continue }
            totals.changed++
            if (next === undefined) unsets.push({ barcode: p.barcode })
            else sets.push({ barcode: p.barcode, kashrut: next })
        }

        if (!dryRun) {
            if (sets.length) {
                await DL.Product.bulkWrite({
                    docs: sets,
                    getFilter: d => ({ barcode: d.barcode }),
                    getUpsert: () => false,
                    getUpdate: d => ({ $set: { kashrut: d.kashrut } })
                })
            }
            if (unsets.length) {
                await DL.Product.bulkWrite({
                    docs: unsets,
                    getFilter: d => ({ barcode: d.barcode }),
                    getUpsert: () => false,
                    getUpdate: () => ({ $unset: { kashrut: '' } })
                })
            }
        }
        totals.written += sets.length + unsets.length
        totals.unset += unsets.length

        lastId = products[products.length - 1]._id
        if (cap && totals.scanned >= cap) break
        if (totals.scanned % 2000 < pageSize)
            console.log(`[backfillKashrut] ${totals.scanned} scanned, ${totals.changed} need normalizing...`)
    }

    console.log(
        `[backfillKashrut] done: scanned=${totals.scanned} resolved=${totals.resolved} ` +
        `orphan=${totals.orphan} mapError=${totals.mapError} legacyString=${totals.legacyString}`
    )
    console.log(
        `[backfillKashrut] changed=${totals.changed} written=${totals.written} ` +
        `unset=${totals.unset} identical=${totals.identical}`
    )
    return totals
}
