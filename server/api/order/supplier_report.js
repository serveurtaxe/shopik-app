/**
 * Month-end supplier report: sums snapshotted supplierTotal per packed+ order.
 * Query by paidAt (set at pack). Includes comaxDoc.docNumber list for client cancellation.
 * GET params: { month: 'YYYY-MM', storeId? }
 */
export default async function supplierReport(payload, { DL }) {
    const { month, storeId } = payload || {}
    if (!month || !/^\d{4}-\d{2}$/.test(String(month))) throw { status: 400, message: 'month YYYY-MM required' }
    const [y, m] = String(month).split('-').map(Number)
    const from = new Date(y, m - 1, 1)
    const to = new Date(y, m, 1)
    const match = {
        paidAt: { $gte: from, $lt: to },
        status: { $in: ['packed', 'shipped', 'done'] }
    }
    if (storeId) match.storeId = storeId
    const rows = await DL.Order.Model.aggregate([
        { $match: match },
        {
            $group: {
                _id: null,
                count: { $sum: 1 },
                supplierTotal: { $sum: { $ifNull: ['$supplierTotal', 0] } },
                saleTotal: { $sum: { $ifNull: ['$finalSumWithShipping', 0] } }
            }
        }
    ])
    const docs = await DL.Order.Model.find(
        { ...match, 'comaxDoc.docNumber': { $exists: true, $ne: null } },
        { _id: 0, number: 1, storeId: 1, paidAt: 1, supplierTotal: 1, 'comaxDoc.docNumber': 1 }
    ).sort({ paidAt: 1 }).lean()
    const totals = rows[0] || { count: 0, supplierTotal: 0, saleTotal: 0 }
    return {
        month,
        storeId: storeId || null,
        count: totals.count,
        supplierTotal: Math.round((totals.supplierTotal || 0) * 100) / 100,
        saleTotal: Math.round((totals.saleTotal || 0) * 100) / 100,
        docNumbers: (docs || []).map(d => ({ orderNumber: d.number, docNumber: d.comaxDoc?.docNumber, storeId: d.storeId, paidAt: d.paidAt, supplierTotal: d.supplierTotal }))
    }
}

supplierReport.config = {
    permissions: ['order:read']
}
