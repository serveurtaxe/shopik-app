import buildCategories from './build_categories.js'
import { buildCategoryPathIds, groupId, subGroupId } from './categoryIds.js'
import enqueueChangedImages from '#server/services/image/enqueue.js'
import log from '#server/utils/log.js'

function isWeightProduct(comax) {
    if (comax.SwWeighable) return true
    // const size = String(comax.Size ?? '').trim().toLowerCase()
    // if (!size) return false
    // const norm = size.replace(/["'`׳״]/g, '').replace(/\s+/g, '')
    // // ק"ג variants: קג, קילו, kg
    // if (norm.includes('קג') || norm.includes('קילו') || norm.includes('kg')) return true
    return false
}

function buildUnit(comax, DL) {
    const isWeight = isWeightProduct(comax)
    if (isWeight) {
        return {
            type: DL.Product.constants.UNIT.WEIGHT,
            baseUnit: DL.Product.constants.BASE_UNIT.KG,
            minAmount: 0.5,
            step: 0.5,
            options: []
        }
    }
    return {
        type: DL.Product.constants.UNIT.ITEM,
        baseUnit: DL.Product.constants.BASE_UNIT.UNIT,
        minAmount: 1,
        step: 1,
        options: []
    }
}

function buildProduct(comax, DL, defaultDomainId, existing, enforceBuyingPrice) {
    const category = {}
    const categoryPathIds = buildCategoryPathIds(comax)
    if (comax.subGroup) {
        category.id = subGroupId(comax.subGroupCode)
        category.title = comax.subGroup
        category.pathIds = categoryPathIds
    } else if (comax.group) {
        category.id = groupId(comax.groupCode)
        category.title = comax.group
        category.pathIds = categoryPathIds
    }
    // No image file = hidden. Re-evaluated every sync, so products flip back to
    // ACTIVE on the first sync after the image worker attaches their image.
    // Missing sale price or buying price = archived (never created).
    const hasImages = (existing?.images?.product || []).length > 0
    const missingPrice = !(comax.price > 0) || (enforceBuyingPrice && !(comax.buyingPrice > 0))
    const status = comax.archived ?
        DL.Product.constants.STATUS.ARCHIVED :
        missingPrice ?
            DL.Product.constants.STATUS.ARCHIVED :
            !hasImages ?
                DL.Product.constants.STATUS.HIDDEN :
                comax.showInWeb ?
                    DL.Product.constants.STATUS.ACTIVE :
                    DL.Product.constants.STATUS.HIDDEN

    return {
        barcode: comax.barcode,
        name: comax.webName || comax.name,
        description: comax.description,
        producer: comax.manufacturer,
        category,
        prices: mergePrices(existing?.prices, defaultDomainId, comax.price > 0 ? comax.price : null),
        buyingPrice: comax.buyingPrice > 0 ? comax.buyingPrice : null,
        status,
        nutrients: {
            alcohol: comax.alcohol
        },
        unit: buildUnit(comax, DL)
    }
}

// Comax owns only the default domain's price entry — entries for other domains
// are preserved so a sync never hides products elsewhere (no price = not sold).
function mergePrices(existingPrices, defaultDomainId, comaxPrice) {
    const kept = (existingPrices || []).filter(p => p?.domainId && p.domainId !== defaultDomainId)
    if (comaxPrice != null) kept.push({ domainId: defaultDomainId, price: comaxPrice })
    return kept
}

export default async function syncComax(payload, { DL }) {
    // Batched sync: the catalog (10-50k docs) must never be fully loaded.
    // A single read({ limit: 0 }) + $in:[all barcodes] + mapped + bulkOps array
    // held 4-5 full copies at once and OOMed 256MB containers.
    const BATCH = Number(process.env.COMAX_SYNC_BATCH || 1000)
    const filter = {
        superDepartmentCode: { $exists: true, $nin: ['12', null] },
        departmentCode: { $exists: true },
        groupCode: { $exists: true }
    }
    const select = {
        _id: 0,
        comaxId: 1,
        barcode: 1,
        name: 1,
        webName: 1,
        description: 1,
        manufacturer: 1,
        superDepartmentCode: 1,
        superDepartment: 1,
        departmentCode: 1,
        department: 1,
        groupCode: 1,
        group: 1,
        subGroupCode: 1,
        subGroup: 1,
        price: 1,
        buyingPrice: 1,
        showInWeb: 1,
        archived: 1,
        Size: 1,
        SwWeighable: 1,
        ContentUnit: 1,
        Content: 1,
        ContentMeasure: 1
    }

    const total = await DL.ComaxProduct.count(filter)
    if (!total) {
        console.log('[Comax Sync] No products to sync')
        return { synced: 0, updated: 0, created: 0 }
    }

    const defaultDomain = await DL.Domain.readOne({ isDefault: true, active: true }, { _id: 0, id: 1 })
    if (!defaultDomain?.id) throw { status: 500, message: 'no default domain configured' }

    // Buying-price requirement is enforced only once buying prices were
    // actually imported — otherwise the first deploy would archive everything.
    const enforceBuyingPrice = await DL.ComaxProduct.count({ buyingPrice: { $gt: 0 } }) > 0
    if (!enforceBuyingPrice)
        console.warn('[Comax Sync] No buying prices imported yet — buyingPrice requirement skipped for this run')

    let synced = 0
    let created = 0
    let updated = 0
    let hiddenNoImage = 0
    let archivedNoPrice = 0

    for (let skip = 0; skip < total; skip += BATCH) {
        const comaxProducts = await DL.ComaxProduct.read(filter, select, {
            limit: BATCH,
            skip,
            sort: { barcode: 1 }
        })
        if (!comaxProducts?.length) break

        // Existing per-domain prices + images so the sync merges prices instead of
        // replacing the array, and hides products with no image file
        const existingProducts = await DL.Product.read(
            { barcode: { $in: comaxProducts.map(c => c.barcode) } },
            { _id: 0, barcode: 1, prices: 1, images: 1 },
            { limit: 0 }
        )
        const existingByBarcode = new Map((existingProducts || []).map(p => [p.barcode, p]))

        const productsToSync = comaxProducts.map(c => buildProduct(c, DL, defaultDomain.id, existingByBarcode.get(c.barcode), enforceBuyingPrice))
        hiddenNoImage += productsToSync.filter(p =>
            p.status === DL.Product.constants.STATUS.HIDDEN &&
            (existingByBarcode.get(p.barcode)?.images?.product || []).length === 0
        ).length
        archivedNoPrice += comaxProducts.filter((c, i) =>
            !c.archived &&
            productsToSync[i].status === DL.Product.constants.STATUS.ARCHIVED &&
            (!(c.price > 0) || (enforceBuyingPrice && !(c.buyingPrice > 0)))
        ).length

        const result = await DL.Product.bulkWrite({
            docs: productsToSync,
            getFilter: p => ({ barcode: p.barcode }),
            // Upsert everything except archived: imageless HIDDEN products must exist
            // as docs or the image worker would never pick them up (deadlock).
            getUpsert: p => p.status !== DL.Product.constants.STATUS.ARCHIVED
        })
        created += result.upsertedCount ?? result.insertedCount ?? 0
        updated += result.modifiedCount ?? 0

        await DL.ComaxProduct.update(
            { comaxId: { $in: comaxProducts.map(p => p.comaxId) } },
            { syncedAt: new Date() }
        )

        synced += comaxProducts.length
        const m = process.memoryUsage()
        console.log(`[Comax Sync] batch ${Math.floor(skip / BATCH) + 1}/${Math.ceil(total / BATCH)}: ${synced}/${total} (heap ${Math.round(m.heapUsed / 1048576)}MB)`)
    }

    console.log(`[Comax Sync] Created ${created}, updated ${updated}, hidden (no image): ${hiddenNoImage}, archived (no price): ${archivedNoPrice}`)

    if (!payload?.skipImageEnqueue) {
        try {
            const enqueued = await enqueueChangedImages(DL)
            log.info(`[Comax Sync] Image queue: ${enqueued.enqueued} jobs`)
        } catch (e) {
            log.warn('[Comax Sync] Image enqueue skipped:', e?.message || e)
        }
    }

    // Rebuild after the product writes so categories reflect this run's statuses.
    // Products hidden for missing images only become active on a later sync.
    await buildCategories(payload, { DL })

    return {
        synced,
        created,
        updated,
        hiddenNoImage,
        archivedNoPrice
    }
}

syncComax.config = {
    required: [],
    permissions: ['product:update'],
    auth: 'required',
    preventMultiple: true
}