import { createHash } from 'node:crypto'
import { SALES_WINDOW_KEY } from '#server/api/comax_product/salesWindow.js'

// Bump whenever the report SHAPE changes (columns, reason wording, row rules).
// The data hash already changes with the columns, but the fast path below only
// compares sourceVersion, so without this an old produced file would be served
// after a deploy that only changed the report code.
//
// 3: archived Comax rows stopped being report rows (they have their own export),
//    and "האם ב GS1" became a dated answer for a barcode our GS1 account does
//    not carry instead of a bare "לא". The ladder's verdict also became a column
//    of its own — "סטטוס לפי כללי האתר" (פעיל / מוסתר / ארכיון באתר) — and the
//    price rules say in the reason that the archive is ours, which is not the
//    same as Comax archiving the item.
//
// 4: "ללא מחיר בקומקס", the filterable price gap. The import stopped asking Comax
//    to select by price list, so items it carries without a price-list entry became
//    rows; 0 and an absent price now both render as an empty cell.
export const REPORT_FORMAT_VERSION = 4

/**
 * Cheap fingerprint of everything the catalog report is built from.
 *
 * Reusing a produced file must be instant, so this deliberately avoids reading
 * the 20k comax rows: it costs a handful of indexed reads (counts, the newest
 * updatedAt, the two sync watermarks, the store list).
 *
 *   comax_products  count + newest updatedAt   (any import / edit)
 *   products        count + newest updatedAt   (GS1 enrich, admin price edit)
 *   gs1_products    count
 *   category_map    count + newest updatedAt   (status + reason rules)
 *   sales window    the configured per-department days (reason text)
 *   sync states     last completed run         (nightly syncs)
 *   stores          active store list          (columns are per store)
 *
 * Any of those moving means the report is rebuilt; the row hash then decides
 * whether the file actually changed.
 */
export default async function sourceVersion(DL) {
    const [
        domain,
        stores,
        comaxCount,
        comaxLast,
        productCount,
        productLast,
        gs1Count,
        categoryMapCount,
        categoryMapLast,
        salesWindow,
        comaxSync,
        gs1Sync
    ] = await Promise.all([
        DL.Domain.readOne({ isDefault: true, active: true }, { _id: 0, id: 1 }),
        DL.Store.Model.find({ active: { $ne: false } }, { _id: 0, id: 1, name: 1 }).sort({ createdAt: 1 }).lean(),
        DL.ComaxProduct.Model.countDocuments({ active: { $ne: false }, isTrailingItem: { $ne: true }, archived: { $ne: true } }),
        DL.ComaxProduct.Model.findOne({}, { _id: 0, updatedAt: 1 }).sort({ updatedAt: -1 }).lean(),
        DL.Product.Model.countDocuments({}),
        DL.Product.Model.findOne({}, { _id: 0, updatedAt: 1 }).sort({ updatedAt: -1 }).lean(),
        DL.Gs1Product.Model.countDocuments({}),
        DL.CategoryMap.Model.countDocuments({}),
        DL.CategoryMap.Model.findOne({}, { _id: 0, updatedAt: 1 }).sort({ updatedAt: -1 }).lean(),
        DL.Setting.readOne({ key: SALES_WINDOW_KEY }, { _id: 0, value: 1 }),
        DL.ComaxSyncState.readOne({ key: 'products' }, { _id: 0, finishedAt: 1 }),
        DL.Gs1SyncState.readOne({ key: 'watermark' }, { _id: 0, lastSyncAt: 1 })
    ])

    const parts = [
        REPORT_FORMAT_VERSION,
        domain?.id || '',
        stores.map(s => `${s.id}:${s.name}`).join(','),
        comaxCount,
        comaxLast?.updatedAt?.toISOString?.() || '',
        productCount,
        productLast?.updatedAt?.toISOString?.() || '',
        gs1Count,
        categoryMapCount,
        categoryMapLast?.updatedAt?.toISOString?.() || '',
        JSON.stringify(salesWindow?.value ?? null),
        comaxSync?.finishedAt?.toISOString?.() || '',
        gs1Sync?.lastSyncAt?.toISOString?.() || ''
    ]

    return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20)
}
