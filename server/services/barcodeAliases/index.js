// Barcode-alias import ("ייבוא שיוך ברקודים").
//
// One CSV row says: this product (main barcode) is also scannable under these
// barcodes. Applying a row does four things, in this order:
//
//   1. writes the main product — its name (locked against Comax/GS1), the
//      merged `scannableBarcodes`, and the family stock/sales/status;
//   2. moves every product doc whose barcode became an alias into
//      `deleted_products` (whole raw doc + rollback info), then deletes it;
//   3. rewrites the `id`/`barcode` of those lines in orders and guest carts.
//      Names, prices and images on the line are historical snapshots and are
//      left alone;
//   4. returns a report of what happened.
//
// The plan (`dryRun: true`, the default) performs every read and none of the
// writes, so the admin can see matches, duplicates and conflicts first.

import { buildFamilyUpdate, readAliasIndex } from '#server/services/productFamily.js'
import { loadCategoryLookup } from '#server/services/categoryMap/index.js'
import { shouldEnforceBuyingPrice } from '#server/api/comax_product/syncRules.js'
import { parseAliasCsv } from './parse.js'

const MAX_CSV_CHARS = 2_000_000
const READ_CHUNK = 500
const REWRITE_CHUNK = 100

const PRODUCT_SELECT = {
    _id: 1,
    barcode: 1,
    id: 1,
    name: 1,
    status: 1,
    storeIds: 1,
    totalSalesUnits: 1,
    prices: 1,
    buyingPrice: 1,
    images: 1,
    kashrut: 1,
    category: 1,
    scannableBarcodes: 1,
    nameLocked: 1
}

const COMAX_SELECT = {
    _id: 0,
    barcode: 1,
    price: 1,
    priceWithTrailing: 1,
    buyingPrice: 1,
    salesLastDays: 1,
    storeIds: 1,
    archived: 1,
    showInWeb: 1,
    subGroupCode: 1
}

function chunks(list, size) {
    const out = []
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
    return out
}

function toCategory(category) {
    if (!category?.id) return null
    return {
        id: category.id,
        title: category.name,
        pathIds: [...(category.parentIds || []), category.id]
    }
}

// The sheet's optional category column accepts either the category id
// (`nc:206:2027`) or its exact display name (`ביצים`).
export function resolveCategory(value, lookup) {
    const raw = String(value ?? '').trim()
    if (!raw) return null
    const byId = lookup?.categoriesById?.get(raw)
    if (byId) return toCategory(byId)
    for (const category of lookup?.categoriesById?.values() || [])
        if (category?.name === raw) return toCategory(category)
    return null
}

/**
 * Pure planning step: which rows can be applied, what each will write, and
 * which barcodes need to be removed first.
 */
export function planAliasRows({
    rows = [],
    parseErrors = [],
    products = [],
    comaxRows = [],
    deletedDocs = [],
    ownerByAlias = new Map(),
    categoryLookup,
    defaultDomainId,
    enforceBuyingPrice = false,
    statuses
} = {}) {
    const productByBarcode = new Map((products || []).map(product => [product.barcode, product]))
    const comaxByBarcode = new Map((comaxRows || []).map(row => [row.barcode, row]))

    // `deleted_products` rows the import wrote earlier. A barcode with a live
    // doc is skipped: the doc holds the current number, the snapshot is history.
    const snapshotByBarcode = new Map()
    for (const snapshot of deletedDocs || []) {
        const barcode = snapshot?.barcode
        if (!barcode || productByBarcode.has(barcode) || snapshotByBarcode.has(barcode)) continue
        snapshotByBarcode.set(barcode, snapshot)
    }

    const mainLines = new Map()
    const secondaryLines = new Map()
    for (const row of rows) {
        if (!mainLines.has(row.mainBarcode)) mainLines.set(row.mainBarcode, [])
        mainLines.get(row.mainBarcode).push(row.line)
        for (const barcode of row.secondaries) {
            if (!secondaryLines.has(barcode)) secondaryLines.set(barcode, new Set())
            secondaryLines.get(barcode).add(row.line)
        }
    }
    const duplicateMains = new Set(
        [...mainLines].filter(([, lines]) => lines.length > 1).map(([barcode]) => barcode)
    )

    const plans = rows.map(row => {
        const main = productByBarcode.get(row.mainBarcode) || null
        const blockers = []

        if (!main) blockers.push({ reason: 'main_not_found' })
        if (duplicateMains.has(row.mainBarcode))
            blockers.push({ reason: 'duplicate_main', lines: mainLines.get(row.mainBarcode) })

        for (const barcode of row.secondaries) {
            if (mainLines.has(barcode))
                blockers.push({ barcode, reason: 'secondary_is_main', lines: mainLines.get(barcode) })
            if ((secondaryLines.get(barcode)?.size || 0) > 1)
                blockers.push({ barcode, reason: 'secondary_claimed_twice' })
            const owner = ownerByAlias.get(barcode)
            if (owner && owner !== row.mainBarcode)
                blockers.push({ barcode, reason: 'already_alias', owner })
        }

        const categoryOverride = row.category ? resolveCategory(row.category, categoryLookup) : null
        if (row.category && !categoryOverride)
            blockers.push({ reason: 'category_not_found', value: row.category })

        const aliasesBefore = [...(main?.scannableBarcodes || [])]
        const aliases = main
            ? [...new Set([...aliasesBefore, ...row.secondaries])].filter(barcode => barcode !== main.barcode)
            : [...new Set(row.secondaries)]

        // Every alias must be a scan alias only: any doc still carrying one of
        // these barcodes is a duplicate, whether it predates this import or a
        // previous run left it behind.
        const duplicates = aliases
            .map(barcode => productByBarcode.get(barcode))
            .filter(product => product && product.barcode !== main?.barcode)
            .map(product => ({
                _id: product._id,
                barcode: product.barcode,
                id: product.id,
                name: product.name || '',
                status: product.status || '',
                totalSalesUnits: product.totalSalesUnits ?? null,
                storeIds: product.storeIds || []
            }))

        const familyRows = main
            ? [...new Set([main.barcode, ...aliases])]
                .map(barcode => comaxByBarcode.get(barcode))
                .filter(Boolean)
            : []
        const familyPlan = main
            ? buildFamilyUpdate({
                owner: { ...main, scannableBarcodes: aliases },
                rows: familyRows,
                categoryLookup,
                defaultDomainId,
                enforceBuyingPrice,
                statuses
            })
            : null

        // Sales Comax can no longer report: an alias barcode that is not
        // measured any more (a retired code) still carries a total the catalog
        // learned earlier — in its doc while it has one, and in its
        // `deleted_products` snapshot after this import removed that doc.
        // Folding both in is what makes re-applying the same file write the
        // same total. The owner's own total is never folded in: the family sum
        // replaces it, and folding it back would count the family sales twice.
        const salesFromDocs = aliases.reduce((total, barcode) => {
            if (Number.isFinite(comaxByBarcode.get(barcode)?.salesLastDays)) return total
            const stored = Number(
                productByBarcode.has(barcode)
                    ? productByBarcode.get(barcode).totalSalesUnits
                    : snapshotByBarcode.get(barcode)?.totalSalesUnits
            )
            return Number.isFinite(stored) ? total + stored : total
        }, 0)

        // A row with no product to attach to writes nothing: applying it would
        // set aliases on a document that does not exist.
        const update = {}
        if (main) {
            if (row.name) {
                update.name = row.name
                // The sheet is a decision: the name stays until a human changes it.
                update.nameLocked = true
            }
            if (aliases.length) update.scannableBarcodes = aliases
            if (familyPlan) Object.assign(update, familyPlan.update)
            if (categoryOverride) update.category = categoryOverride
            if (salesFromDocs > 0)
                update.totalSalesUnits = Math.round(((update.totalSalesUnits ?? 0) + salesFromDocs) * 1000) / 1000
        }

        return {
            line: row.line,
            name: row.name,
            mainBarcode: row.mainBarcode,
            mainId: main?.id || null,
            mainName: main?.name || '',
            mainFound: !!main,
            secondaries: row.secondaries,
            invalidSecondaries: row.invalidSecondaries || [],
            aliasesBefore,
            aliases,
            duplicates,
            blockers,
            blocked: blockers.length > 0,
            category: update.category || main?.category || null,
            statusBefore: main?.status ?? null,
            statusAfter: update.status ?? main?.status ?? null,
            salesBefore: main?.totalSalesUnits ?? null,
            salesAfter: update.totalSalesUnits ?? main?.totalSalesUnits ?? null,
            // Part of salesAfter that came from the deleted duplicates rather
            // than from a Comax measurement (see the note above).
            salesFromDocs,
            storesBefore: [...(main?.storeIds || [])],
            storesAfter: update.storeIds ?? [...(main?.storeIds || [])],
            update
        }
    })

    return { plans, parseErrors }
}

function summarize(plans = [], parseErrors = []) {
    const applicable = plans.filter(plan => plan.mainFound && !plan.blocked)
    return {
        rows: plans.length + parseErrors.length,
        validRows: plans.length,
        applicable: applicable.length,
        blocked: plans.filter(plan => plan.blocked).length,
        missingMain: plans.filter(plan => !plan.mainFound).length,
        aliases: applicable.reduce((count, plan) => count + plan.aliases.length, 0),
        duplicateDocs: applicable.reduce((count, plan) => count + plan.duplicates.length, 0),
        parseErrors: parseErrors.length
    }
}

export async function readProducts(DL, barcodes = []) {
    const products = []
    for (const chunk of chunks([...new Set(barcodes)], READ_CHUNK)) {
        const docs = await DL.Product.read({ barcode: { $in: chunk } }, PRODUCT_SELECT, { limit: 0 })
        products.push(...(docs || []))
    }
    return products
}

async function readComaxRows(DL, barcodes = []) {
    const rows = []
    for (const chunk of chunks([...new Set(barcodes)], READ_CHUNK)) {
        const docs = await DL.ComaxProduct.read({ barcode: { $in: chunk } }, COMAX_SELECT, { limit: 0 })
        rows.push(...(docs || []))
    }
    return rows
}

// Snapshots of family barcodes this (or an earlier) import already removed.
// Raw `Model.find` because `restoredAt` is not a declared filter field.
async function readDeletedDocs(DL, barcodes = []) {
    const Model = DL?.DeletedProduct?.Model
    if (!Model?.find) return []
    const out = []
    for (const chunk of chunks([...new Set(barcodes)], READ_CHUNK)) {
        const docs = await Model.find(
            { barcode: { $in: chunk }, restoredAt: null },
            { _id: 0, barcode: 1, 'product.totalSalesUnits': 1 }
        ).sort({ deletedAt: -1 }).lean()
        for (const doc of docs || [])
            out.push({ barcode: doc.barcode, totalSalesUnits: doc?.product?.totalSalesUnits })
    }
    return out
}

/**
 * Read everything the plan needs and (unless `dryRun === false`) apply it.
 *
 * @param {{ csv: string, dryRun?: boolean, adminId?: string }} payload
 */
export async function planBarcodeAliases(payload = {}, { DL } = {}) {
    const csv = typeof payload.csv === 'string' ? payload.csv : ''
    if (!csv.trim()) throw { status: 400, message: 'missing csv' }
    if (csv.length > MAX_CSV_CHARS)
        throw { status: 400, message: `csv too large (max ${MAX_CSV_CHARS} characters)` }

    const dryRun = payload.dryRun !== false
    const { rows, errors } = parseAliasCsv(csv)
    if (!rows.length)
        throw {
            status: 400,
            message: errors.length ? `CSV has no valid rows (${errors.length} errors)` : 'CSV has no rows'
        }

    const barcodes = [...new Set(rows.flatMap(row => [row.mainBarcode, ...row.secondaries]))]

    const [products, comaxRows, deletedDocs, { ownerByAlias }, categoryLookup, defaultDomain, enforceBuyingPrice] = await Promise.all([
        readProducts(DL, barcodes),
        readComaxRows(DL, barcodes),
        readDeletedDocs(DL, barcodes),
        readAliasIndex(DL),
        loadCategoryLookup(DL),
        DL.Domain?.readOne
            ? DL.Domain.readOne({ isDefault: true, active: true }, { _id: 0, id: 1 })
            : null,
        shouldEnforceBuyingPrice(DL)
    ])

    const { plans } = planAliasRows({
        rows,
        parseErrors: errors,
        products,
        comaxRows,
        deletedDocs,
        ownerByAlias,
        categoryLookup,
        defaultDomainId: defaultDomain?.id,
        enforceBuyingPrice,
        statuses: DL.Product.constants.STATUS
    })

    const report = {
        dryRun,
        stats: summarize(plans, errors),
        rows: plans,
        errors
    }
    if (dryRun) return report

    report.applied = await applyBarcodeAliases(plans, {
        DL,
        adminId: payload.adminId
    })
    return report
}

/**
 * Rewrite `cart[].id` / `cart[].barcode` from a deleted product to its owner.
 *
 * Keyset-paged by order id and applied per alias with `arrayFilters`, so only
 * the matching line changes. Name/price/images on the line are the snapshot
 * the customer saw and are deliberately untouched.
 */
export async function rewriteCartRefs(Model, mappings = []) {
    if (!Model?.find || !mappings?.length) return 0

    const barcodes = [...new Set(mappings.map(mapping => mapping.barcode))]
    const ids = [...new Set(mappings.map(mapping => mapping.id).filter(Boolean))]
    let afterId = ''
    let touched = 0

    while (true) {
        const orders = await Model.find(
            {
                id: { $gt: afterId },
                $or: [{ 'cart.barcode': { $in: barcodes } }, { 'cart.id': { $in: ids } }]
            },
            { _id: 0, id: 1 }
        ).sort({ id: 1 }).limit(REWRITE_CHUNK).lean()
        if (!orders?.length) break

        afterId = orders[orders.length - 1].id
        const orderIds = orders.map(order => order.id)

        for (const mapping of mappings) {
            const byBarcode = await Model.updateMany(
                { id: { $in: orderIds }, 'cart.barcode': mapping.barcode },
                { $set: { 'cart.$[item].id': mapping.ownerId, 'cart.$[item].barcode': mapping.ownerBarcode } },
                { arrayFilters: [{ 'item.barcode': mapping.barcode }] }
            )
            touched += byBarcode?.modifiedCount || 0

            const byId = await Model.updateMany(
                { id: { $in: orderIds }, 'cart.id': mapping.id },
                { $set: { 'cart.$[item].id': mapping.ownerId, 'cart.$[item].barcode': mapping.ownerBarcode } },
                { arrayFilters: [{ 'item.id': mapping.id }] }
            )
            touched += byId?.modifiedCount || 0
        }

        if (orders.length < REWRITE_CHUNK) break
    }

    return touched
}

export async function applyBarcodeAliases(plans = [], { DL, adminId = null } = {}) {
    const applicable = plans.filter(plan => plan.mainFound && !plan.blocked)
    let deleted = 0
    let ordersRewritten = 0
    let cartsRewritten = 0
    const rows = []

    for (const plan of applicable) {
        // 1. Main product first: if this fails, nothing has been deleted yet.
        if (Object.keys(plan.update).length)
            await DL.Product.updateOne({ id: plan.mainId }, plan.update)

        // 2. Snapshot then delete every doc that now carries an alias barcode.
        const mappings = []
        for (const duplicate of plan.duplicates) {
            const raw = await DL.Product.Model.findById(duplicate._id).lean()
            if (!raw) continue

            await DL.DeletedProduct.create({
                barcode: raw.barcode,
                productId: raw.id,
                product: raw,
                mainBarcode: plan.mainBarcode,
                previousScannableBarcodes: plan.aliasesBefore,
                reason: 'barcode-alias-import',
                deletedBy: adminId || null,
                deletedAt: new Date()
            })

            const res = await DL.Product.deleteOne({ id: raw.id })
            if (!res?.deletedCount) continue

            deleted++
            mappings.push({
                barcode: raw.barcode,
                id: raw.id,
                ownerBarcode: plan.mainBarcode,
                ownerId: plan.mainId
            })
        }

        // 3. Historical lines keep their snapshot but point at the product.
        if (mappings.length) {
            ordersRewritten += await rewriteCartRefs(DL.Order?.Model, mappings)
            cartsRewritten += await rewriteCartRefs(DL.GuestCart?.Model, mappings)
        }

        rows.push({ line: plan.line, mainBarcode: plan.mainBarcode, deleted: mappings.length })
    }

    return { rows: applicable.length, deleted, ordersRewritten, cartsRewritten, detail: rows }
}

export default { planBarcodeAliases, planAliasRows, applyBarcodeAliases, rewriteCartRefs }
