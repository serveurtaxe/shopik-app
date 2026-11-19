// Barcode families: one product, several scannable barcodes.
//
// The barcode is what Comax and GS1 know; the product is what the site sells.
// A family is the product plus everything in `scannableBarcodes`, and the
// supplier often keeps selling the same item under more than one barcode
// (repackaging, a new GTIN, an old internal code). These helpers keep the two
// worlds consistent:
//
//   - an alias barcode never becomes its own Product doc;
//   - stock is the union over the family, so the product is sellable wherever
//     any of its barcodes is actually on the shelf;
//   - sales are summed over the family, so popularity is not split between the
//     barcodes the item used to have.
//
// Everything here is pure except the two `read*` helpers, which own the raw
// model reads needed to page a large catalog without loading it whole.

import { productCategoryFor } from '#server/services/categoryMap/index.js'
import { deriveStatus, retailPrice } from '#server/api/comax_product/status.js'

const FALLBACK_STATUS = { ACTIVE: 'active', HIDDEN: 'hidden', ARCHIVED: 'archived' }

// The product's own barcode first, then its aliases, deduped.
export function familyBarcodes(owner) {
    return [...new Set([owner?.barcode, ...(owner?.scannableBarcodes || [])].filter(Boolean))]
}

/**
 * alias barcode -> owner barcode.
 *
 * Two products claiming the same alias are ambiguous (a scan cannot choose
 * between them), so that alias is dropped from the index instead of picking a
 * winner. The caller gets the list to report.
 */
export function buildAliasIndex(products = []) {
    const ownerByAlias = new Map()
    const ambiguous = new Set()

    for (const product of products || []) {
        if (!product?.barcode) continue
        for (const raw of product.scannableBarcodes || []) {
            const barcode = String(raw ?? '').trim()
            if (!barcode || barcode === product.barcode) continue
            const owner = ownerByAlias.get(barcode)
            if (owner && owner !== product.barcode) {
                ambiguous.add(barcode)
                continue
            }
            ownerByAlias.set(barcode, product.barcode)
        }
    }

    for (const barcode of ambiguous) ownerByAlias.delete(barcode)
    return { ownerByAlias, ambiguous: [...ambiguous] }
}

// Only docs that actually carry aliases are loaded: the whole point is that
// this set stays small compared to the catalog. Raw `Model.find` because
// `scannableBarcodes.0` is not a declared filter field and processFilter would
// strip it (turning the query into a full-catalog read).
export async function readAliasIndex(DL) {
    const Model = DL?.Product?.Model
    if (!Model?.find) return buildAliasIndex([])
    const docs = await Model.find(
        { 'scannableBarcodes.0': { $exists: true } },
        { _id: 0, barcode: 1, scannableBarcodes: 1 }
    ).lean()
    return buildAliasIndex(docs)
}

// Keyset page of family owners (`barcode > afterBarcode`). Barcode is unique,
// so no page can repeat or skip an owner, and the sort stays index-backed.
export async function readFamilyOwners(DL, { afterBarcode = null, limit = 1000 } = {}) {
    const Model = DL?.Product?.Model
    if (!Model?.find) return []
    const filter = { 'scannableBarcodes.0': { $exists: true } }
    if (afterBarcode) filter.barcode = { $gt: afterBarcode }
    return Model.find(filter)
        .select({
            _id: 0,
            id: 1,
            barcode: 1,
            scannableBarcodes: 1,
            prices: 1,
            buyingPrice: 1,
            images: 1,
            'kashrut.rabbinates': 1,
            category: 1
        })
        .sort({ barcode: 1 })
        .limit(Number(limit) || 1000)
        .lean()
}

/**
 * Which Comax row describes the family: the product's own row when it has one,
 * otherwise the best alias row — in season before archived, then the most
 * stocked, then the best seller, then barcode for determinism.
 */
export function pickEffectiveComaxRow(rows = []) {
    return [...(rows || [])].sort((a, b) =>
        (Number(!!a?.archived) - Number(!!b?.archived))
        || ((b?.storeIds?.length || 0) - (a?.storeIds?.length || 0))
        || ((Number(b?.salesLastDays) || 0) - (Number(a?.salesLastDays) || 0))
        || String(a?.barcode || '').localeCompare(String(b?.barcode || ''))
    )[0] || null
}

// Sum of the measured rows; null when no row was measured at all, so callers
// can leave a backfilled total untouched (same rule as buildProduct).
export function sumFamilySales(rows = []) {
    let total = 0
    let measured = false
    for (const row of rows || []) {
        const units = row?.salesLastDays
        if (!Number.isFinite(units)) continue
        measured = true
        total += units
    }
    return measured ? Math.round(total * 1000) / 1000 : null
}

// Union of every tracked store list. null when no row was ever tracked, which
// means "unknown" and must not hide the product.
export function unionStoreIds(rows = []) {
    const ids = new Set()
    let tracked = false
    for (const row of rows || []) {
        if (!Array.isArray(row?.storeIds)) continue
        tracked = true
        for (const id of row.storeIds) if (id) ids.add(id)
    }
    return tracked ? [...ids].sort() : null
}

function storedPriceOf(owner, defaultDomainId) {
    const prices = owner?.prices || []
    const price = defaultDomainId
        ? prices.find(entry => entry?.domainId === defaultDomainId)?.price
        : prices.find(entry => entry?.price > 0)?.price
    const value = Number(price)
    return Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * The fields the family — rather than a single Comax row — decides for a
 * product: stock union, sales sum and the status derived from them.
 *
 * Deliberately narrow. Price, name, category and images are not family data:
 * the product's stored price stays (unless it has its own Comax row), and the
 * name is whatever the admin/import chose. When the owner has no Comax row of
 * its own the effective alias row supplies the sub-group (and therefore the
 * category) and the `showInWeb`/`archived` signals, nothing else.
 *
 * @returns {{ update: object, effective: object, familyRows: object[] } | null}
 */
export function buildFamilyUpdate({
    owner,
    rows = [],
    categoryLookup,
    defaultDomainId,
    enforceBuyingPrice = false,
    statuses
} = {}) {
    if (!owner?.barcode || !rows?.length) return null

    const family = new Set(familyBarcodes(owner))
    const familyRows = (rows || []).filter(row => row?.barcode && family.has(row.barcode))
    if (!familyRows.length) return null

    const own = familyRows.find(row => row.barcode === owner.barcode) || null
    const effective = own || pickEffectiveComaxRow(familyRows)
    if (!effective) return null

    const storeIds = unionStoreIds(familyRows)
    const totalSalesUnits = sumFamilySales(familyRows)
    const subGroupCode = effective.subGroupCode == null ? null : String(effective.subGroupCode)
    const category = subGroupCode ? productCategoryFor(subGroupCode, categoryLookup) : null

    // A product without its own Comax row keeps the price the catalog already
    // shows. Only the status ladder gets a fallback from the alias row, so a
    // priced product is not archived merely because the row it inherited has
    // no price of its own.
    const ownPrice = own ? retailPrice(own) : 0
    const price = ownPrice > 0
        ? ownPrice
        : (storedPriceOf(owner, defaultDomainId) || retailPrice(effective))

    // One barcode still in season keeps the family live, and one barcode shown
    // in the web keeps the family visible.
    const archived = familyRows.every(row => row.archived === true)
    const showInWeb = familyRows.some(row => row.showInWeb === true)
        ? true
        : effective.showInWeb

    const status = deriveStatus({
        comax: {
            ...effective,
            price,
            priceWithTrailing: own ? own.priceWithTrailing : undefined,
            buyingPrice: own ? own.buyingPrice : owner.buyingPrice,
            storeIds: storeIds ?? effective.storeIds,
            archived,
            showInWeb
        },
        existing: owner,
        flags: subGroupCode ? categoryLookup?.flagsByCode?.get(subGroupCode) : null,
        status: statuses || FALLBACK_STATUS,
        enforceBuyingPrice
    })

    const update = { status }
    if (storeIds) update.storeIds = storeIds
    if (totalSalesUnits != null) update.totalSalesUnits = totalSalesUnits

    // Without its own Comax row the product has no category/sub-group of its
    // own; take them from the effective family row so it lands where its
    // siblings live (and the status flag sweeps can see it).
    if (!own) {
        if (category) update.category = category
        if (subGroupCode) update.comaxSubGroupCode = subGroupCode
    }

    return { update, effective, familyRows }
}

export default {
    familyBarcodes,
    buildAliasIndex,
    readAliasIndex,
    readFamilyOwners,
    pickEffectiveComaxRow,
    sumFamilySales,
    unionStoreIds,
    buildFamilyUpdate
}
