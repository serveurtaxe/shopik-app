import { resolvePromotionStoreCodes, buildOtherStoreFilter, matchesPromotionStore } from './promotionStore.js'

async function pruneOtherStoreSales(DL, storeCodes) {
    const { STATUS } = DL.Sale.constants
    const staleSales = await DL.ComaxSale.Model.find(
        buildOtherStoreFilter(storeCodes),
        { _id: 0, comaxId: 1 }
    ).lean()
    const prunedIds = (staleSales || []).map(sale => sale.comaxId).filter(Boolean)
    if (prunedIds.length === 0) {
        return { pruned: 0, canceled: 0 }
    }

    await DL.ComaxSale.Model.deleteMany({ comaxId: { $in: prunedIds } })
    const canceled = await DL.Sale.update(
        {
            id: { $in: prunedIds },
            createdBy: 'Comax Sync',
            status: { $in: [STATUS.ACTIVE, STATUS.PENDING] }
        },
        { status: STATUS.CANCELED }
    )
    const canceledCount = canceled?.modifiedCount || canceled?.nModified || 0

    console.log(`[Comax Sales Import] Pruned ${prunedIds.length} sales for other stores, canceled ${canceledCount}`)

    return { pruned: prunedIds.length, canceled: canceledCount }
}

export default async function importComaxSales(payload, { DL, external }) {
    const storeCodes = resolvePromotionStoreCodes()
    const lastImportSale = await DL.ComaxSale.Model.findOne({}, { _id: 0, lastImportedAt: 1 })
        .sort({ lastImportedAt: -1 })
        .lean()
    const lastImportedAt = new Date()

    const fetchedSales = await external.comax.getPromotions({
        // lastUpdatedDate: lastImportSale?.lastImportedAt ?? '',
        justActive: payload.justActive ?? true,
        futurePromotions: payload.futurePromotions ?? true,
        storeList: storeCodes
    })

    const comaxSales = fetchedSales.filter(sale => matchesPromotionStore(sale, storeCodes))
    const pruneResult = await pruneOtherStoreSales(DL, storeCodes)

    if (comaxSales.length === 0) {
        return { message: 'No sales to import', count: 0, ...pruneResult }
    }

    const enriched = comaxSales.map(s => ({
        ...s,
        lastImportedAt
    }))

    const result = await DL.ComaxSale.bulkWrite({
        docs: enriched,
        getUpsert: () => true,
        getFilter: s => ({ comaxId: s.comaxId })
    })

    console.log(`[Comax Sales Import] Inserted/updated ${result.insertedCount || result.modifiedCount || enriched.length} sales`)

    return {
        message: 'Import complete',
        count: enriched.length,
        ...pruneResult
    }
}

importComaxSales.config = {
    permissions: ['comax_sale:update']
}
