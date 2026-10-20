export function buildSyncFilter() {
    return {
        active: { $ne: false },
        superDepartmentCode: { $exists: true, $nin: ['12', null] },
        departmentCode: { $exists: true },
        groupCode: { $exists: true }
    }
}

function statuses(DL) {
    return DL.Product.constants.STATUS
}

export async function hideActiveProduct({ DL, barcode }) {
    if (!barcode) return 0
    const { ACTIVE, HIDDEN } = statuses(DL)
    const res = await DL.Product.update(
        { barcode, status: ACTIVE },
        { status: HIDDEN }
    )
    return res?.modifiedCount || 0
}

export async function hideInactiveProducts({ DL, batchSize } = {}) {
    const BATCH = Number(batchSize || process.env.COMAX_SYNC_BATCH || 1000)
    const { ACTIVE, HIDDEN } = statuses(DL)
    const filter = { active: false, barcode: { $nin: [null, ''] } }

    const total = await DL.ComaxProduct.count(filter)
    let hidden = 0

    for (let skip = 0; skip < total; skip += BATCH) {
        const rows = await DL.ComaxProduct.read(
            filter,
            { _id: 0, barcode: 1 },
            { limit: BATCH, skip, sort: { barcode: 1 } }
        )
        if (!rows?.length) break

        const barcodes = rows.map(r => r.barcode).filter(Boolean)
        if (!barcodes.length) continue

        const res = await DL.Product.update(
            { barcode: { $in: barcodes }, status: ACTIVE },
            { status: HIDDEN }
        )
        hidden += res?.modifiedCount || 0
    }

    return hidden
}
