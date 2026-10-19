import { CACHE_STRATEGIES } from '#common/constants.js'

const cashRegisterSchema = {
    type: { type: String, default: 'comax', enum: ['comax'] },
    storeId: { type: String, required: true, unique: true, filter: true },
    data: {
        StockStoreID: String,
        OrderStoreID: String,
        DeliveryCustomerID: String
    }
}

export const meta = {
    cacheStrategy: CACHE_STRATEGIES.HASHSET
}

export default cashRegisterSchema
