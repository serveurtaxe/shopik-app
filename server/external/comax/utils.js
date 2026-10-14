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
    lastUpdatedFromDate: 'LastUpdatedFromDate',
    withOutArchive: 'WithOutArchive'
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

