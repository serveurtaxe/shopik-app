/**
 * Backfill: derive `Product.diet` (normalized GS1 Diet_Information claims) and
 * the nutrition `Product.nutrients` flags (GS1 Food_Symbol_Red: FSR2 sodium,
 * FSR3 sugar, FSR4 saturated fat, FSR5 green symbol; plus alcohol) from the
 * stored GS1 raw.
 *
 * Products enriched before mapDiet / the FSR5 flag existed carry neither, so the
 * diet icons and food-symbol stamps would be missing. mapGs1ToProduct
 * (server/external/gs1/mapper.js) now emits them; this rewrites what's stored.
 *
 * Only `diet` is replaced and only truthy nutrient flags are added — existing
 * flags (e.g. alcohol set by the Comax sync) are never cleared.
 *
 * Source of truth per product, in order:
 *   1. gs1_products by Product.gs1ProductCode (stored pointer from enrich),
 *   2. gs1_products by exact barcode (GTIN === product barcode),
 *   3. reverse-alias: product short uniquely derivable from a GTIN.
 *
 * Usage: node server/scripts/runBackfillProductNutrition.js [--dry-run]
 *          [--limit N] [--page N]
 */
import { mapDiet, mapNutrients } from '#server/external/gs1/mapper.js'
import { aliasCandidates, aliasEnabled, aliasMinLen } from '#server/services/gs1/alias.js'

const DEFAULT_PAGE = 200

const stable = v => JSON.stringify(v ?? null)

export default async function backfillProductNutrition(
    { DL } = {},
    { dryRun = false, limit = 0, page = DEFAULT_PAGE } = {}
) {
    if (!DL?.Product?.Model || !DL?.Gs1Product) throw new Error('DL required')
    const cap = Number(limit) || 0
    const pageSize = Math.max(1, Number(page) || DEFAULT_PAGE)
    const Product = DL.Product.Model

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
        changed: 0, written: 0, unset: 0, identical: 0
    }

    console.log(`[backfillNutrition] scanning products${dryRun ? ' (DRY RUN — no writes)' : ''}`)
    let lastId = null
    for (; ;) {
        const filter = lastId ? { _id: { $gt: lastId } } : {}
        const products = await Product.find(
            filter,
            { _id: 1, barcode: 1, diet: 1, nutrients: 1, gs1ProductCode: 1 }
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

        const updates = []
        for (const p of products) {
            if (cap && totals.scanned >= cap) break
            totals.scanned++
            const r = resolveGtin(p)
            if (!r.gtin || !rawByGtin.has(r.gtin) || rawByGtin.get(r.gtin) == null) {
                totals.orphan++
                continue
            }
            totals.resolved++
            let diet, nutrients
            try {
                const info = rawByGtin.get(r.gtin)?.product_info || {}
                diet = mapDiet(info?.Product_Components_and_Instructions_General?.Diet_Information)
                nutrients = mapNutrients(info?.Additional_Information)
            } catch {
                totals.mapError++
                continue
            }

            const nextDiet = diet.length ? diet : undefined
            const dietChanged = stable(p.diet) !== stable(nextDiet ?? null)

            const $set = {}
            const $unset = {}
            if (dietChanged) {
                if (nextDiet) $set.diet = nextDiet
                else $unset.diet = ''
            }
            // Only add flags; never clear what another source may have set.
            for (const [flag, value] of Object.entries(nutrients)) {
                if (value === true && p?.nutrients?.[flag] !== true)
                    $set[`nutrients.${flag}`] = true
            }

            if (!Object.keys($set).length && !Object.keys($unset).length) {
                totals.identical++
                continue
            }
            totals.changed++

            const update = {}
            if (Object.keys($set).length) update.$set = $set
            if (Object.keys($unset).length) update.$unset = $unset
            updates.push({ barcode: p.barcode, update })
        }

        if (!dryRun && updates.length) {
            await DL.Product.bulkWrite({
                docs: updates,
                getFilter: d => ({ barcode: d.barcode }),
                getUpsert: () => false,
                getUpdate: d => d.update
            })
        }
        totals.written += updates.length

        lastId = products[products.length - 1]._id
        if (cap && totals.scanned >= cap) break
        if (totals.scanned % 2000 < pageSize)
            console.log(`[backfillNutrition] ${totals.scanned} scanned, ${totals.changed} need normalizing...`)
    }

    console.log(
        `[backfillNutrition] done: scanned=${totals.scanned} resolved=${totals.resolved} ` +
        `orphan=${totals.orphan} mapError=${totals.mapError}`
    )
    console.log(
        `[backfillNutrition] changed=${totals.changed} written=${totals.written} identical=${totals.identical}`
    )
    return totals
}
