export default async function claim(payload, { DL, _admin, external, utils }) {
    const { id } = payload
    if (!id) throw { status: 400, message: 'order id required' }

    const adminName = `${_admin.name?.first ?? ''} ${_admin.name?.last ?? ''}`.trim()

    const order = await DL.Order.updateOne(
        { id, status: 'paid' },
        {
            $set: {
                status: 'picking',
                pickStart: new Date(),
                picker: { adminId: _admin.id, name: adminName }
            }
        }
    )

    if (!order) throw { status: 409, message: 'order is already being picked or not available' }

    // store scope sanity — revert if store mismatch
    if (_admin.currentStoreId && order.storeId !== _admin.currentStoreId) {
        await DL.Order.Model.updateOne({ id }, { $set: { status: 'paid', picker: null, pickStart: null } }).lean()
        throw { status: 403, message: 'order store mismatch' }
    }

    await utils.data.orderSms.sendOrderStageSms({
        DL,
        external,
        order,
        stage: 'picking',
        adminId: _admin.id
    })

    // history: owner
    try {
        await DL.Owner.create({
            orderId: id,
            adminId: _admin.id,
            adminName,
            start: new Date(),
            type: 'picking',
            status: 'active'
        })
    } catch {}

    try {
        const { record, adminActor } = utils.data.timeline
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_STATUS_UPDATE,
            actor: adminActor(_admin),
            changes: { oldData: { status: 'paid' }, newData: { status: 'picking', picker: { adminId: _admin.id } } },
            context: { step: 'pick_claim' },
            metadata: { source: 'order/ops/claim' }
        })
    } catch {}

    return order
}

claim.config = {
    permissions: ['order:pick'],
    preventMultiple: p => ':' + (p.id || '')
}
