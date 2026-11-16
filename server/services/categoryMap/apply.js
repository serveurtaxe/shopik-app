import { buildCategoryPlan } from './parse.js'
import { productCategoryFor } from './lookup.js'
import { COMAX_META_FIELDS, metaFromComax } from './metadata.js'
import { mirrorCategoryActive } from './categoryActive.js'
import { applyCategoryFlagStatuses } from './flagStatus.js'
import { invalidateMenu } from '#server/utils/data/getMenu.js'
import { scanDel } from '#server/utils/data/displayBlocks.js'

const BATCH = 1000

async function applyCategories(DL, plan) {
    const existing = await DL.Category.read(
        {},
        { _id: 0, id: 1, icon: 1, sortOrder: 1, active: 1 },
        { limit: 0 }
    )
    const existingById = new Map((existing || []).map(category => [category.id, category]))

    // The CSV defines the tree *and* its sibling order (first appearance of a
    // category sets its sortOrder), so bulk reordering is possible by editing
    // the file. Icon and active are admin-only and survive a re-import.
    const docs = plan.categories.map(node => {
        const previous = existingById.get(node.id)
        const doc = { ...node }
        if (previous) {
            if ('icon' in previous) doc.icon = previous.icon
            if (typeof previous.active === 'boolean') doc.active = previous.active
        }
        return doc
    })

    await DL.Category.bulkWrite({
        docs,
        getFilter: doc => ({ id: doc.id }),
        getUpsert: () => true
    })

    const keepIds = docs.map(doc => doc.id)
    const staleIds = await DL.Category.Model.distinct('id', { id: { $nin: keepIds } })
    if (staleIds.length) {
        await DL.Category.Model.deleteMany({ id: { $in: staleIds } })
        // Direct Model writes bypass the DL wrappers — drop them from the hashset
        // too, otherwise the admin tree and menu keep deleted categories.
        await DL.Category.cache.del(staleIds)
    }

    return {
        total: docs.length,
        removed: staleIds.length
    }
}

async function backfillProducts(DL, plan) {
    const lookup = {
        hasMap: true,
        mapByCode: new Map(plan.map.map(row => [row.subGroupCode, row.categoryId])),
        categoriesById: new Map(plan.categories.map(category => [category.id, category]))
    }

    const metaByCode = new Map()
    let updated = 0
    let afterBarcode = null

    while (true) {
        // Keyset on the unique barcode: a sorted skip page over the whole catalog
        // goes past MongoDB's 32MB sort buffer (see api/comax_product/sync.js).
        const batch = await DL.ComaxProduct.read(
            afterBarcode ? { barcode: { $gt: afterBarcode } } : {},
            { _id: 0, barcode: 1, subGroupCode: 1, ...COMAX_META_FIELDS },
            { limit: BATCH, sort: { barcode: 1 } }
        )
        if (!batch?.length) break

        const ops = batch.map(comax => {
            const code = comax.subGroupCode == null ? null : String(comax.subGroupCode)
            if (code && !metaByCode.has(code)) metaByCode.set(code, metaFromComax(comax))

            const category = productCategoryFor(code, lookup)
            const update = { $set: { comaxSubGroupCode: code } }
            if (category) update.$set.category = category
            else update.$unset = { category: '' }

            return { updateOne: { filter: { barcode: comax.barcode }, update } }
        })

        if (ops.length) {
            const result = await DL.Product.Model.bulkWrite(ops, { ordered: false })
            updated += result?.modifiedCount || 0
        }

        const lastBarcode = batch[batch.length - 1]?.barcode
        if (!lastBarcode) break
        afterBarcode = lastBarcode
        if (batch.length < BATCH) break
    }

    return { updated, metaByCode }
}

async function applyMap(DL, plan, activeCodes, metaByCode) {
    const docs = plan.map.map(row => ({ ...row }))
    const keep = new Set(docs.map(row => row.subGroupCode))

    // Every active-product sub-group must exist in the map. Codes the CSV did
    // not mention stay unassigned (categoryId: null) and show up in the admin.
    for (const code of activeCodes) {
        if (keep.has(code)) continue
        docs.push({
            subGroupCode: code,
            categoryId: null,
            ...(metaByCode.get(code) || {})
        })
        keep.add(code)
    }

    await DL.CategoryMap.bulkWrite({
        docs,
        getFilter: doc => ({ subGroupCode: doc.subGroupCode }),
        getUpsert: () => true
    })

    const stale = await DL.CategoryMap.Model.distinct(
        'subGroupCode',
        { subGroupCode: { $nin: [...keep] } }
    )
    if (stale.length)
        await DL.CategoryMap.Model.deleteMany({ subGroupCode: { $in: stale } })

    return {
        total: docs.length,
        unassigned: docs.filter(row => !row.categoryId).length,
        removed: stale.length
    }
}

/**
 * Replace the whole category tree + sub-group map from a CSV, then re-point
 * every product at the new categories. `productsUpdated` counts modified
 * product rows (not the catalog size).
 */
export async function applyCategoryMap({ DL, csvText, filename }) {
    const plan = buildCategoryPlan(csvText)

    // Create the tree first so the product backfill never points at a category
    // that does not exist yet.
    const categories = await applyCategories(DL, plan)
    const products = await backfillProducts(DL, plan)

    const activeCodes = (await DL.Product.Model.distinct(
        'comaxSubGroupCode',
        { status: DL.Product.constants.STATUS.ACTIVE }
    ))
        .filter(code => code != null && String(code).trim() !== '')
        .map(String)

    const map = await applyMap(DL, plan, activeCodes, products.metaByCode)

    // The imported tree may re-point sub-groups (and carries each category's
    // existing active flag), so reconcile the mirror and the catalog after it.
    const mirror = await mirrorCategoryActive({ DL })
    const status = await applyCategoryFlagStatuses({ DL, relaxCodes: mirror.relaxed })

    await invalidateMenu({ DL })
    if (status.toWrite && DL.redis) await scanDel(DL.redis, 'display:*')

    return {
        filename: filename || null,
        categories: categories.total,
        removedCategories: categories.removed,
        level1: plan.counts.l1,
        level2: plan.counts.l2,
        level3: plan.counts.l3,
        map: map.total,
        unassigned: map.unassigned,
        removedMap: map.removed,
        productsUpdated: products.updated,
        categoryActive: mirror.written,
        hidden: status.hidden,
        unhidden: status.unhidden
    }
}
