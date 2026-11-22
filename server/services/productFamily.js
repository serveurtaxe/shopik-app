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
            label: 1,
            images: 1,
            'kashrut.rabbinates': 1,
            category: 1
        })
        .sort({ barcode: 1 })
        .limit(Number(limit) || 1000)
        .lean()
}

/**
 * Last label of each family barcode whose doc the alias import removed.
 *
 * A brand is GS1 data that lived on the alias's own doc; once that doc is gone
 * the snapshot is the only place left to ask whether the family is uniform.
 * Raw `Model.find` because `restoredAt` is not a declared filter field.
 */
export async function readDeletedLabels(DL, barcodes = []) {
    const Model = DL?.DeletedProduct?.Model
    if (!Model?.find || !barcodes?.length) return new Map()
    const docs = await Model.find(
        { barcode: { $in: [...new Set(barcodes)] }, restoredAt: null },
        { _id: 0, barcode: 1, 'product.label': 1 }
    ).sort({ deletedAt: -1 }).lean()

    const byBarcode = new Map()
    for (const doc of docs || []) {
        if (!doc?.barcode || byBarcode.has(doc.barcode)) continue
        byBarcode.set(doc.barcode, doc?.product?.label ?? '')
    }
    return byBarcode
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

/**
 * The label (brand) the family may show.
 *
 * `label` comes from GS1 and belongs to one GTIN, not to a family: the picker
 * may hand over any alias, so a label may only be shown when every barcode in
 * the family carries the same one. An alias with no label is not "the same" —
 * it cannot promise the main's brand. Returns '' when they disagree.
 */
export function familyLabel(ownerLabel, memberLabels = []) {
    const labels = [ownerLabel, ...(memberLabels || [])]
        .map(value => String(value ?? '').trim())
    const [first] = labels
    if (!first) return ''
    const key = first.toLowerCase()
    return labels.every(label => label.toLowerCase() === key) ? first : ''
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
 * product: stock union, sales sum, the status derived from them, and the label
 * (a brand only when every family barcode carries the same one).
 *
 * Deliberately narrow. Price, name, category and images are not family data:
 * the product's stored price stays (unless it has its own Comax row), and the
 * name is whatever the admin/import chose. When the owner has no Comax row of
 * its own the effective alias row supplies the sub-group (and therefore the
 * category) and the `showInWeb`/`archived` signals, nothing else.
 *
 * @param {{ owner: object, rows?: object[], memberLabels?: string[] }} args
 *   `memberLabels` are the labels of the owner's aliases (live docs or their
 *   deleted snapshots), never Comax data — Comax has no brand field.
 * @returns {{ update: object, effective: object, familyRows: object[] } | null}
 */
export function buildFamilyUpdate({
    owner,
    rows = [],
    categoryLookup,
    defaultDomainId,
    enforceBuyingPrice = false,
    statuses,
    memberLabels = []
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
    // Comax's own numbers for the family, and nothing else: the total is
    // rewritten every night from what Comax returns.
    if (totalSalesUnits != null) update.totalSalesUnits = totalSalesUnits

    // Without its own Comax row the product has no category/sub-group of its
    // own; take them from the effective family row so it lands where its
    // siblings live (and the status flag sweeps can see it).
    if (!own) {
        if (category) update.category = category
        if (subGroupCode) update.comaxSubGroupCode = subGroupCode
    }

    // A brand only survives while the whole family carries it: the picker may
    // hand over any alias, so a label the aliases do not share is a promise the
    // storefront cannot keep.
    const label = familyLabel(owner.label, memberLabels)
    if ((owner.label ?? '') !== label) update.label = label

    return { update, effective, familyRows }
}

export default {
    familyBarcodes,
    buildAliasIndex,
    readAliasIndex,
    readFamilyOwners,
    readDeletedLabels,
    pickEffectiveComaxRow,
    sumFamilySales,
    unionStoreIds,
    familyLabel,
    buildFamilyUpdate
}
