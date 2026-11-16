/**
 * Kill switch for the Comax delivery-doc flow (write + fetch + cron).
 * Off unless explicitly enabled: COMAX_DELIVERY_ENABLED=true.
 * When disabled, pack/retry skip silently so enabling later backfills
 * naturally via comax_retry.
 */
export function isComaxDeliveryEnabled() {
    return String(process.env.COMAX_DELIVERY_ENABLED || '').toLowerCase() === 'true'
}

/**
 * Parse Comax date format "DD/MM/YYYY" → Date or null.
 */
export function parseComaxDate(value) {
    if (!value || value === '01/01/0001') return null
    const parts = String(value).split('/')
    if (parts.length !== 3) return null
    const [day, month, year] = parts.map(Number)
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null
    return new Date(year, month - 1, day)
}
const nameMap = {
    storeId: 'StoreID',
    loginId: 'LoginID',
    loginPassword: 'LoginPassword',
    priceListId: 'PriceListID',
    departmentId: 'DepartmentID',
    groupId: 'GroupID',
    subGroupId: 'Sub_GroupID',
    supplierId: 'SupplierID',
    customerId: 'CustomerID',
    itemId: 'ItemID',
    itemModelId: 'ItemModelID',
    itemColorId: 'ItemColorID',
    itemSizeId: 'ItemSizeID',
    storeIdForOpenOrdersOffset: 'StoreIDForOpenOrdersOffset',
    lastUpdatedFromDate: 'LastUpdatedFromDate'
    // withOutArchive is deliberately NOT here: it has a default (1) that the loop
    // below could never override, because `result[comaxKey]` is already set.
    // It is applied explicitly instead, so a caller can ask for archived items.
}

/**
 * The price lists requested in one response, comma-separated.
 *
 * Comax returns them under `item.SalesPrice.ClsItemPrices[]`, so the store feed
 * gets the retail price (1069) and the delivery/buying price (255) in the same
 * call instead of a second full import. Note this adds roughly 11% to the
 * payload and does NOT change `item.Price`, which still reflects `PriceListID`.
 */
export function buildSalesPriceArray(options = {}) {
    const ids = [
        options.priceListId || process.env.COMAX_PRICELIST_ID,
        options.deliveryPriceListId || process.env.COMAX_DELIVERY_PRICELIST_ID
    ]
        .map(v => String(v ?? '').trim())
        .filter(Boolean)
    return [...new Set(ids)].join(',')
}

/**
 * Convert options object → Comax query params.
 *   camelCase → PascalCase
 *   booleans → 1/0
 *   dates → dd/MM/yyyy
 *   arrays → comma-separated strings
 *   undefined/null → removed
 */
export function buildComaxParams(options) {
    const result = {
        LoginID: options.loginId || process.env.COMAX_LOGIN_ID,
        LoginPassword: options.loginPassword || process.env.COMAX_LOGIN_PASSWORD,
        StoreID: options.storeId || process.env.COMAX_STORE_ID,
        PriceListID: options.priceListId || process.env.COMAX_PRICELIST_ID,
        WithOutArchive: 1
    }

    for (const [key, comaxKey] of Object.entries(nameMap)) {
        const value = options[key]
        if (!comaxKey || result[comaxKey]) continue

        if (value == null || value === undefined) {
            result[comaxKey] = ''
        } else if (typeof value === 'boolean') {
            result[comaxKey] = value ? 1 : 0
        } else if (Array.isArray(value)) {
            result[comaxKey] = value.join(',')
        } else if (value instanceof Date) {
            result[comaxKey] = formatComaxDate(value)
        } else {
            result[comaxKey] = value
        }
    }

    // WithOutArchive=1 means "hide archived items". Default stays 1; a caller that
    // needs archived items (or needs to prove an item is archived) passes
    // withOutArchive: false explicitly.
    if (options.withOutArchive != null) result.WithOutArchive = options.withOutArchive ? 1 : 0

    // Undocumented but real Comax filters. They are only sent when the caller
    // asks for them, so every other request stays byte-identical to before.
    if (options.hasInventory != null) result.HasInventory = options.hasInventory ? 1 : 0
    if (options.selByPriceList != null) result.SelByPriceList = options.selByPriceList ? 1 : 0
    if (options.salesPriceArray) result.SalesPriceArray = options.salesPriceArray

    return result
}

export function formatComaxDate(date) {
    const d = date instanceof Date ? date : new Date(date)
    const day = String(d.getDate()).padStart(2, '0')
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const y = d.getFullYear()
    return `${day}/${m}/${y}`
}

export function buildComaxPromotionParams(options = {}) {
    const paramsObj = {}

    if (options.promoId != null) paramsObj.PromoID = Number(options.promoId)
    if (options.promoC != null) paramsObj.PromoC = Number(options.promoC)
    if (options.lastUpdatedDate) {
        if (options.lastUpdatedDate instanceof Date) {
            paramsObj.LastUpdatedDate = formatComaxDateTime(options.lastUpdatedDate)
        } else {
            paramsObj.LastUpdatedDate = String(options.lastUpdatedDate)
        }
    }
    if (options.typesList != null) {
        paramsObj.TypesList = Array.isArray(options.typesList) ? options.typesList.join(',') : String(options.typesList)
    }
    if (options.justActive != null) paramsObj.JustActive = !!options.justActive
    if (options.storeList != null) {
        paramsObj.StoreList = Array.isArray(options.storeList) ? options.storeList.join(',') : String(options.storeList)
    }
    if (options.futurePromotions != null) paramsObj.FuturePromotions = !!options.futurePromotions

    return JSON.stringify(paramsObj)
}

export function formatComaxDateTime(date) {
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    const y = date.getFullYear()
    const hh = String(date.getHours()).padStart(2, '0')
    const mm = String(date.getMinutes()).padStart(2, '0')
    return `${m}/${d}/${y} ${hh}:${mm}`
}

export function parseComaxDateTime(value) {
    if (!value || value === '01/01/0001' || String(value).startsWith('01/01/0001')) return null
    const [datePart, timePart] = String(value).trim().split(' ')
    if (!datePart) return null
    const dateParts = datePart.split('/')
    if (dateParts.length !== 3) return null
    const [day, month, year] = dateParts.map(Number)
    if (isNaN(day) || isNaN(month) || isNaN(year)) return null
    let hours = 0, minutes = 0, seconds = 0
    if (timePart) {
        const timeParts = timePart.split(':').map(Number)
        hours = timeParts[0] || 0
        minutes = timeParts[1] || 0
        seconds = timeParts[2] || 0
    }
    return new Date(year, month - 1, day, hours, minutes, seconds)
}

