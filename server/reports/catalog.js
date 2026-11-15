import { selectKashrutStamps, getSupervisionLabel, hasValidKashrut } from '#common/components/Kashrut/constants.js'
import { explainStatus, STATUS_REASON } from '#server/api/comax_product/status.js'
import { resolveSalesWindow, buildDepartmentWindows, daysForDepartment, isWithinWindow } from '#server/api/comax_product/salesWindow.js'
import { shouldEnforceBuyingPrice } from '#server/api/comax_product/syncRules.js'

/**
 * Product catalog report — one row per active Comax product.
 *
 * Source of truth is the Comax collection (comax_products); Product only adds
 * the fields Comax does not carry (web name and price, kashrut, images),
 * CategoryMap answers "קטגוריה מוצגת באתר" and Gs1Product only answers
 * "is it in GS1".
 *
 * "קיים באתר" and "סיבת אי הצגה באתר" are derived from the SAME status ladder
 * the nightly sync uses (explainStatus), so the report cannot tell the team a
 * product is eligible while the sync would keep it off the site. The ladder only
 * decides visibility; actually creating the Product doc still needs a buying
 * price (the sync gate).
 *
 * "מכר", "תאריך מכירה אחרונה" and the stale-sales reason make the sales window
 * visible: an item that has not sold inside its department's window loses its
 * stores and therefore drops off the site on the next import. The units are the
 * import's sum over the widest configured window; a missing value means the feed
 * never measured it, which is not the same as 0.
 *
 * One "האם בסניף X" column per ACTIVE store, so adding a store changes the
 * report shape — the column list is part of the row hash, so that alone
 * produces a fresh file.
 */

const YES = 'כן'
const NO = 'לא'

const BASE_COLUMNS = [
    { text: 'מחלקה עליונה', width: 22, align: 'right' },
    { text: 'מחלקה', width: 28, align: 'right' },
    { text: 'קטגוריה', width: 30, align: 'right' },
    { text: 'תת קטגוריה', width: 34, align: 'right' },
    { text: 'קטגוריה מוצגת באתר', width: 20, align: 'center' },
    { text: 'קטגוריה דורשת כשרות', width: 20, align: 'center' },
    { text: 'ברקוד', width: 14, align: 'center', asText: true },
    { text: 'שם מוצר', width: 46, align: 'right' },
    { text: 'שם ספק', width: 24, align: 'right' },
    { text: 'כשרות', width: 48, align: 'right' },
    { text: 'כשרות מתאימה', width: 15, align: 'center' },
    { text: 'VAT', width: 8, align: 'center' },
    { text: 'האם ב GS1', width: 14, align: 'center' },
    { text: 'מחיר קנייה', width: 13, align: 'left', money: true },
    { text: 'מחיר מכירה', width: 13, align: 'left', money: true },
    { text: 'האם יש תמונה', width: 14, align: 'center' },
    { text: 'מכר', width: 12, align: 'center' },
    { text: 'תאריך מכירה אחרונה', width: 16, align: 'center' },
    { text: 'קיים באתר', width: 12, align: 'center' },
    { text: 'סיבת אי הצגה באתר', width: 52, align: 'right', wrap: true }
]

// Hebrew labels for the ladder reasons. Kept in the report (not in status.js)
// because they are presentation, while the codes are the shared contract.
const REASON_TEXT = {
    [STATUS_REASON.COMAX_ARCHIVED]: 'המוצר הועבר לארכיון בקומקס',
    [STATUS_REASON.NO_PRICE]: 'חסר מחיר מכירה בקומקס',
    [STATUS_REASON.NO_BUYING_PRICE]: 'חסר מחיר קנייה (לא נוסף למחירון)',
    [STATUS_REASON.NO_IMAGE]: 'חסרה תמונה',
    [STATUS_REASON.NO_STORES]: 'לא קיים באף סניף',
    [STATUS_REASON.NOT_IN_WEB]: 'לא מוצג באתר בקומקס',
    [STATUS_REASON.CATEGORY_INACTIVE]: 'הקטגוריה לא פעילה באתר',
    [STATUS_REASON.SUBGROUP_HIDDEN]: 'תת הקטגוריה מוסתרת באתר',
    [STATUS_REASON.KASHRUT_MISSING]: 'חסרה כשרות מתאימה'
}

// Join key: Comax and Product disagree on leading zeros often enough that a
// raw string join silently drops rows.
function normBarcode(barcode) {
    const str = String(barcode ?? '').trim()
    if (!str || !/^\d+$/.test(str)) return str
    return str.replace(/^0+(?=\d)/, '')
}

// Rabbinate names (strongest first) plus the GS1 food category when present,
// e.g. 'בד"ץ העדה החרדית ירושלים (חלבי)'.
function kashrutText(kashrut) {
    const names = selectKashrutStamps(kashrut, Infinity).map(entry => entry.name).filter(Boolean)
    const kind = getSupervisionLabel(kashrut)
    if (names.length && kind) return `${names.join(', ')} (${kind})`
    if (names.length) return names.join(', ')
    return kind || ''
}

const yesNo = value => value ? YES : NO

function toDate(value) {
    if (!value) return null
    const date = value instanceof Date ? value : new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
}

// Display only: DD/MM/YYYY, matching the rest of the admin UI. The stored value
// is the newest sale across stores, written by the import's sales-window feed.
function formatDate(value) {
    const date = toDate(value)
    if (!date) return ''
    const pad = number => String(number).padStart(2, '0')
    return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}`
}

// A Comax picUrl is a source the image worker can fetch, not a stored image;
// the ladder requires images.product, so say which of the two is missing.
function reasonText(reason, item) {
    if (reason === STATUS_REASON.NO_IMAGE && item.picUrl)
        return 'תמונה טרם נטענה מקומקס'
    return REASON_TEXT[reason] || reason
}

/**
 * Why the item is outside its department's sale window, or null when it sold
 * inside it. `0` days means the window is disabled. This is informational: the
 * mechanical rule that hides the product is the empty storeIds list, but the
 * sales date is what explains it to the team.
 */
function staleSalesText(item, windows, now) {
    const days = daysForDepartment(windows, item.departmentCode)
    if (!(days > 0)) return null

    const lastSale = toDate(item.lastSaleDate)
    if (!lastSale) return 'לא נמכר (אין מכירה מתועדת)'
    if (isWithinWindow(lastSale, days, now)) return null
    return `לא נמכר מאז ${formatDate(lastSale)}`
}

// Empty values sort last (the old report did the same), so products with no
// category do not push the whole catalog down a screen.
function compare(a, b) {
    const x = a || '\uffff'
    const y = b || '\uffff'
    return x < y ? -1 : x > y ? 1 : 0
}

async function build(DL) {
    const [
        defaultDomain,
        stores,
        comax,
        products,
        categoryFlags,
        gs1Barcodes,
        enforceBuyingPrice,
        salesWindow
    ] = await Promise.all([
        DL.Domain.readOne({ isDefault: true, active: true }, { _id: 0, id: 1 }),
        DL.Store.Model.find({ active: { $ne: false } }, { _id: 0, id: 1, name: 1 }).sort({ createdAt: 1 }).lean(),
        DL.ComaxProduct.Model.find(
            { active: { $ne: false }, isTrailingItem: { $ne: true } },
            {
                _id: 0, barcode: 1, name: 1, supplier: 1, price: 1, priceWithTrailing: 1, buyingPrice: 1,
                vat: 1, archived: 1, showInWeb: 1, lastSaleDate: 1, salesLastDays: 1,
                superDepartment: 1, department: 1, departmentCode: 1, group: 1, subGroup: 1,
                subGroupCode: 1, storeIds: 1, picUrl: 1
            }
        ).lean(),
        DL.Product.Model.find(
            {},
            { _id: 0, barcode: 1, name: 1, prices: 1, kashrut: 1, 'images.product': 1, gs1SyncedAt: 1 }
        ).lean(),
        DL.CategoryMap.read(
            {},
            { _id: 0, subGroupCode: 1, showOnSite: 1, requireKashrut: 1, categoryActive: 1 },
            { limit: 0 }
        ),
        DL.Gs1Product.Model.distinct('barcode'),
        shouldEnforceBuyingPrice(DL),
        // The resolved config is the raw { defaultDays, rules }; the report asks
        // "which window applies to this department", which needs the lookup the
        // nightly import builds from the same config.
        resolveSalesWindow(DL).then(buildDepartmentWindows)
    ])

    const productByBarcode = new Map()
    for (const product of products) {
        if (product.barcode == null) continue
        const key = normBarcode(product.barcode)
        if (!productByBarcode.has(key)) productByBarcode.set(key, product)
    }
    const gs1Set = new Set(gs1Barcodes.map(normBarcode))

    // 'קטגוריה מוצגת באתר' and 'קטגוריה דורשת כשרות' answer the category_map
    // flags, not the status ladder: stored values grade the cell, missing flag
    // fields mean the ladder defaults (show / no kashrut requirement). A
    // sub-group with no category_map row at all is unknown — empty cell.
    const flagsBySubGroup = new Map((categoryFlags || [])
        .map(row => [String(row.subGroupCode ?? ''), row]))

    const columns = [
        ...BASE_COLUMNS,
        ...stores.map(store => ({
            text: `האם בסניף ${store.name}`,
            width: 20,
            align: 'center'
        }))
    ]

    const status = DL.Product.constants.STATUS
    const now = new Date()

    const rows = comax.map(item => {
        const key = normBarcode(item.barcode)
        const product = productByBarcode.get(key)
        const subGroupCode = String(item.subGroupCode ?? '').trim()
        const flags = flagsBySubGroup.get(subGroupCode)
        const explained = explainStatus({
            comax: item,
            existing: product,
            flags,
            status,
            enforceBuyingPrice
        })
        const existsOnSite = explained.status === status.ACTIVE
        const reasons = explained.reasons.map(reason => reasonText(reason, item))

        // A row that is already on site keeps an empty reason even if its last
        // sale is old; the date column still shows the staleness.
        if (!existsOnSite) {
            const staleSales = staleSalesText(item, salesWindow, now)
            if (staleSales) reasons.push(staleSales)
        }

        return {
            superDepartment: item.superDepartment || '',
            department: item.department || '',
            group: item.group || '',
            subGroup: item.subGroup || '',
            categoryShown: flags ? yesNo(flags.showOnSite !== false) : '',
            categoryRequires: flags ? yesNo(flags.requireKashrut === true) : '',
            barcode: String(item.barcode ?? ''),
            name: product?.name || item.name || '',
            supplier: item.supplier || '',
            kashrut: kashrutText(product?.kashrut),
            kashrutValid: yesNo(hasValidKashrut(product?.kashrut)),
            vat: item.vat === true ? 'true' : item.vat === false ? 'false' : '',
            inGs1: yesNo(gs1Set.has(key) || !!product?.gs1SyncedAt),
            buyingPrice: item.buyingPrice ?? null,
            salePrice: product?.prices?.find(price => price?.domainId === defaultDomain?.id)?.price ?? item.price ?? null,
            hasImage: yesNo((product?.images?.product || []).length > 0 || !!item.picUrl),
            // Missing means the sales feed never measured this item — leave the
            // cell empty rather than claiming zero sales.
            unitsSold: Number.isFinite(item.salesLastDays) ? item.salesLastDays : null,
            lastSaleDate: formatDate(item.lastSaleDate),
            existsOnSite: yesNo(existsOnSite),
            reason: reasons.join(' · '),
            stores: stores.map(store => yesNo((item.storeIds || []).includes(store.id)))
        }
    })

    rows.sort((a, b) =>
        compare(a.superDepartment, b.superDepartment) ||
        compare(a.department, b.department) ||
        compare(a.group, b.group) ||
        compare(a.subGroup, b.subGroup) ||
        compare(a.name, b.name) ||
        compare(a.barcode, b.barcode)
    )

    return {
        columns,
        rows: rows.map(row => [
            row.superDepartment,
            row.department,
            row.group,
            row.subGroup,
            row.categoryShown,
            row.categoryRequires,
            row.barcode,
            row.name,
            row.supplier,
            row.kashrut,
            row.kashrutValid,
            row.vat,
            row.inGs1,
            row.buyingPrice,
            row.salePrice,
            row.hasImage,
            row.unitsSold,
            row.lastSaleDate,
            row.existsOnSite,
            row.reason,
            ...row.stores
        ])
    }
}

export default {
    id: 'catalog',
    // File name shown on download; the date is appended when it is produced.
    fileName: 'דוח מוצרים',
    sheetName: 'דוח מוצרים',
    // Snapshot of the current catalog — there is no date to filter on.
    dateRange: false,
    build
}
