/**
 * Central resolver for Comax delivery-document config.
 * Precedence (per-store first, global fallback):
 *   customerId  = cash_register.data.DeliveryCustomerID -> COMAX_CUSTOMER_ID env
 *   storeId     = cash_register.data.OrderStoreID only
 *   priceListId = COMAX_DELIVERY_PRICELIST_ID -> COMAX_PRICELIST_ID env
 * Switching to a single global customer later = set COMAX_CUSTOMER_ID
 * (optionally COMAX_USE_GLOBAL_CUSTOMER=true to ignore per-store values).
 */
export async function resolveDeliveryConfig(DL, storeId) {
    let reg = null
    try {
        if (storeId) reg = await DL.CashRegister.readOne({ storeId })
    } catch {}
    const useGlobal = String(process.env.COMAX_USE_GLOBAL_CUSTOMER || 'false').toLowerCase() === 'true'
    const perStoreCustomer = (reg?.data?.DeliveryCustomerID || '').toString().trim()
    const globalCustomer = (process.env.COMAX_CUSTOMER_ID || '').toString().trim()
    const customerId = useGlobal ? globalCustomer : (perStoreCustomer || globalCustomer)
    const comaxStoreId = (reg?.data?.OrderStoreID || '').toString().trim()
    return {
        customerId: customerId || '',
        comaxStoreId: comaxStoreId || '',
        priceListId: (process.env.COMAX_DELIVERY_PRICELIST_ID || process.env.COMAX_PRICELIST_ID || '').toString().trim(),
        loginId: process.env.COMAX_LOGIN_ID,
        loginPassword: process.env.COMAX_LOGIN_PASSWORD,
        hasCustomer: Boolean(customerId),
        registerFound: Boolean(reg)
    }
}

export default resolveDeliveryConfig
