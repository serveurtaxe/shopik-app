import {
    buildSyncFilter,
    hideCategoryFlaggedProducts,
    hideInactiveProducts,
    hideKashrutMissingProducts,
    hideStorelessProducts,
    shouldEnforceBuyingPrice
} from './syncRules.js'
import { deriveStatus, retailPrice } from './status.js'
import { loadCategoryLookup, productCategoryFor } from '#server/services/categoryMap/index.js'
import { invalidateMenu } from '#server/utils/data/getMenu.js'
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

export function buildProduct(comax, DL, defaultDomainId, existing, enforceBuyingPrice, categoryLookup) {
    const subGroupCode = comax.subGroupCode == null ? null : String(comax.subGroupCode)
    const resolvedCategory = productCategoryFor(subGroupCode, categoryLookup)
    // Before the first category-map import there is no map at all; keep the
    // stored category instead of wiping the catalog. Once a map exists, an
    // unassigned sub-group intentionally clears it.
    const category = categoryLookup?.hasMap
        ? (resolvedCategory || {})
        : (existing?.category || {})
    // Status is re-derived every sync (see deriveStatus): an image, a valid
    // kashrut or a flag change flips it back on its own. The category flags
    // come from the same lookup used for the category itself.
    const status = deriveStatus({
        comax,
        existing,
        flags: subGroupCode ? categoryLookup?.flagsByCode?.get(subGroupCode) : null,
        status: DL.Product.constants.STATUS,
        enforceBuyingPrice
    })
    const price = retailPrice(comax)
    const storeIds = Array.isArray(comax.storeIds) ? comax.storeIds : null

    return {
        barcode: comax.barcode,
        name: comax.webName || comax.name,
        description: comax.description,
        producer: comax.manufacturer,
        category,
        comaxSubGroupCode: subGroupCode,
        prices: mergePrices(existing?.prices, defaultDomainId, price > 0 ? price : null),
        buyingPrice: comax.buyingPrice > 0 ? comax.buyingPrice : null,
        vat: comax.vat !== false,
        // A never-tracked item keeps its stored value (the key is omitted, so the
        // bulk $set never touches it).
        ...(storeIds ? { storeIds } : {}),
        // Same rule for the sales total: an item the import never measured keeps
        // whatever the one-off report backfill wrote.
        ...(Number.isFinite(comax.salesLastDays) ? { totalSalesUnits: comax.salesLastDays } : {}),
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
    const filter = buildSyncFilter()
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
        priceWithTrailing: 1,
        buyingPrice: 1,
        vat: 1,
        showInWeb: 1,
        archived: 1,
        // Written by the import's per-store feeds; copied onto products below.
        storeIds: 1,
        // Units over the sales window, summed across stores by the import.
        salesLastDays: 1,
        Size: 1,
        SwWeighable: 1,
        ContentUnit: 1,
        Content: 1,
        ContentMeasure: 1
    }

    const total = await DL.ComaxProduct.count(filter)
    const hiddenInactive = await hideInactiveProducts({ DL })
    if (hiddenInactive)
        console.log(`[Comax Sync] Hidden ${hiddenInactive} product(s) for inactive Comax items`)

    if (!total) {
        // Still sweep: the catalog can hold products whose Comax row is gone.
        const hiddenNoStock = await hideStorelessProducts({ DL })
        const hiddenFlagged = await hideCategoryFlaggedProducts({ DL })
        const hiddenKashrut = await hideKashrutMissingProducts({ DL })
        if (hiddenInactive || hiddenNoStock || hiddenFlagged || hiddenKashrut)
            await invalidateMenu({ DL })
        console.log(`[Comax Sync] No products to sync${hiddenNoStock ? ` — hid ${hiddenNoStock} storeless product(s)` : ''}`)
        return {
            synced: 0,
            updated: 0,
            created: 0,
            hiddenInactive,
            hiddenNoStock,
            hiddenFlagged,
            hiddenKashrut
        }
    }

    const defaultDomain = await DL.Domain.readOne({ isDefault: true, active: true }, { _id: 0, id: 1 })
    if (!defaultDomain?.id) throw { status: 500, message: 'no default domain configured' }

    const categoryLookup = await loadCategoryLookup(DL)

    // Buying-price requirement is enforced only once buying prices were
    // actually imported — otherwise the first deploy would archive everything.
    const enforceBuyingPrice = await shouldEnforceBuyingPrice(DL)
    if (!enforceBuyingPrice)
        console.warn('[Comax Sync] No buying prices imported yet — buyingPrice requirement skipped for this run')

    let synced = 0
    let created = 0
    let updated = 0
    let hiddenNoImage = 0
    let archivedNoPrice = 0

    // Keyset paging on the unique barcode instead of skip: MongoDB bounds a
    // blocking sort by skip + limit, so skip-paging a 24k catalog died with
    // 'Sort exceeded memory limit of 33554432 bytes' once skip passed 23000.
    // Walking barcode > last barcode keeps every page a TopK sort of BATCH docs.
    let afterBarcode = null
    let page = 0
    while (true) {
        const comaxProducts = await DL.ComaxProduct.read(
            afterBarcode ? { ...filter, barcode: { $gt: afterBarcode } } : filter,
            select,
            { limit: BATCH, sort: { barcode: 1 } }
        )
        if (!comaxProducts?.length) break

        // Existing per-domain prices + images so the sync merges prices instead of
        // replacing the array, and hides products with no image file
        const existingProducts = await DL.Product.read(
            { barcode: { $in: comaxProducts.map(c => c.barcode) } },
            { _id: 0, barcode: 1, prices: 1, images: 1, 'kashrut.rabbinates': 1 },
            { limit: 0 }
        )
        const existingByBarcode = new Map((existingProducts || []).map(p => [p.barcode, p]))

        const productsToSync = comaxProducts.map(c => buildProduct(c, DL, defaultDomain.id, existingByBarcode.get(c.barcode), enforceBuyingPrice, categoryLookup))
        hiddenNoImage += productsToSync.filter(p =>
            p.status === DL.Product.constants.STATUS.HIDDEN &&
            (existingByBarcode.get(p.barcode)?.images?.product || []).length === 0
        ).length
        archivedNoPrice += comaxProducts.filter((c, i) =>
            !c.archived &&
            productsToSync[i].status === DL.Product.constants.STATUS.ARCHIVED &&
            (!(retailPrice(c) > 0) || (enforceBuyingPrice && !(c.buyingPrice > 0)))
        ).length

        // Comax's archive is seasonal, not dead stock: those rows need a doc so
        // the image worker and GS1 enrich can fill it while it is off the site.
        const seasonal = new Set(comaxProducts.filter(c => c.archived).map(c => c.barcode))
        const result = await DL.Product.bulkWrite({
            docs: productsToSync,
            getFilter: p => ({ barcode: p.barcode }),
            // Upsert everything except archived: imageless HIDDEN products must exist
            // as docs or the image worker would never pick them up (deadlock). The
            // one exception is a Comax-archived (seasonal) item: its doc is created
            // as ARCHIVED, so it stays off the site but its images and kashrut can
            // be ready on the day the item comes back.
            getUpsert: p => p.status !== DL.Product.constants.STATUS.ARCHIVED || seasonal.has(p.barcode)
        })
        created += result.upsertedCount ?? result.insertedCount ?? 0
        updated += result.modifiedCount ?? 0

        await DL.ComaxProduct.update(
            { comaxId: { $in: comaxProducts.map(p => p.comaxId) } },
            { syncedAt: new Date() }
        )

        synced += comaxProducts.length
        page++
        const m = process.memoryUsage()
        console.log(`[Comax Sync] batch ${page}/${Math.ceil(total / BATCH)}: ${synced}/${total} (heap ${Math.round(m.heapUsed / 1048576)}MB)`)

        // The cursor must advance or the same page reads forever. barcode is
        // required and unique, so a row without one is broken data: stop rather
        // than loop on it.
        const lastBarcode = comaxProducts[comaxProducts.length - 1]?.barcode
        if (!lastBarcode || comaxProducts.length < BATCH) break
        afterBarcode = lastBarcode
    }

    // Backstop for products the loop never visits: no Comax row (or one the
    // sync filter excludes) means their status would never be re-evaluated.
    const hiddenNoStock = await hideStorelessProducts({ DL })
    const hiddenFlagged = await hideCategoryFlaggedProducts({ DL })
    const hiddenKashrut = await hideKashrutMissingProducts({ DL })

    console.log(`[Comax Sync] Created ${created}, updated ${updated}, hidden (no image): ${hiddenNoImage}, hidden (no stock): ${hiddenNoStock}, hidden (flag): ${hiddenFlagged}, hidden (kashrut): ${hiddenKashrut}, archived (no price): ${archivedNoPrice}, hidden (inactive): ${hiddenInactive}`)

    if (!payload?.skipImageEnqueue) {
        try {
            const enqueued = await enqueueChangedImages(DL)
            log.info(`[Comax Sync] Image queue: ${enqueued.enqueued} jobs`)
        } catch (e) {
            log.warn('[Comax Sync] Image enqueue skipped:', e?.message || e)
        }
    }

    // Product statuses drive the storefront menu (which categories have an
    // active product), so drop the per-store menu cache after every run.
    await invalidateMenu({ DL })

    return {
        synced,
        created,
        updated,
        hiddenNoImage,
        hiddenNoStock,
        hiddenFlagged,
        hiddenKashrut,
        archivedNoPrice,
        hiddenInactive
    }
}

syncComax.config = {
    required: [],
    permissions: ['product:update'],
    auth: 'required',
    preventMultiple: true
}