import getStoreForAddress from './getStoreForAddress.js'
import handleSelect from '#server/dl/handleSelect.js'
import { record, userActor } from './timeline.js'
import enrichCart from './enrichCart.js'

export default async function getUserOrder({ DL, _user }) {
    const cartOrder = await DL.Order.readOne(
        { userId: _user.id, status: 'cart', active: true },
        DL.Order.defaultSelect
    )

    if (cartOrder) {
        await enrichCart(cartOrder, DL)
        return cartOrder
    }
    const { DELIVERY_METHOD } = DL.Order.constants
    if (!_user.deliveryMethod) {
        _user.deliveryMethod = DELIVERY_METHOD.DELIVERY
    }
    const activeAddress = _user?.addresses?.find(a => a.active)

    const order = {
        userId: _user.id,
        deliveryMethod: _user.deliveryMethod,
        domainId: _user.domainId
    }

    if (activeAddress && order.deliveryMethod === DELIVERY_METHOD.DELIVERY) {
        order.address = activeAddress
        const storeId = await getStoreForAddress({ DL, address: activeAddress })
        if (storeId) order.storeId = storeId
    } else if (order.deliveryMethod === DELIVERY_METHOD.PICKUP) {
        if (_user.pickupStoreId) {
            const store = await DL.Store.readById(_user.pickupStoreId)
            if (store?.active) {
                order.storeId = _user.pickupStoreId
                order.address = store.address
            }
        }
    }

    try {
        order.number = await DL.Order.getNumber()
        const newOrder = await DL.Order.create(order)
        await record({
            DL,
            order: newOrder,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_CREATED,
            actor: userActor(_user),
            context: { creationData: { deliveryMethod: newOrder.deliveryMethod } }
        })
        const selected = handleSelect(newOrder, DL.Order.defaultSelect)
        await enrichCart(selected, DL)
        return selected
    } catch (err) {
        const existing = await DL.Order.readOne(
            { userId: _user.id, status: 'cart', active: true },
            DL.Order.defaultSelect
        )
        if (existing) return existing
        throw { status: 500, message: 'Failed to create cart order' }
    }
}