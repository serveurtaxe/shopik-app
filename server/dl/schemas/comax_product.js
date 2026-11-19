import { CACHE_STRATEGIES } from '#common/constants.js'

const comaxProductSchema = {
    comaxId: String,
    // filter: 'exact' — the unique barcode index is the fastest path there is, and a
    // case-insensitive prefix regex (what processFilter builds for a plain String
    // filter) cannot bound it: an admin barcode filter fetched all 30 973 rows to
    // return one (Atlas: 854 ms, targeting 20 358). Explain-verified: exact → 1 key.
    barcode: { type: String, required: true, unique: true, filter: 'exact' },

    name: { type: String, filter: true },
    englishName: String,
    webName: String,
    description: String,
    remark: String,
    alternateId: String,
    serial: String,

    quantity: Number,
    price: Number,
    supplierPrice: Number,
    buyingPrice: Number,

    // Comax "trailing item" (TrailingItem) = the refundable deposit charged
    // next to the product, e.g. 0.30 for a bottle. It is stored as its own
    // comax_products row (isTrailingItem) and referenced here from the parent.
    // price stays the original Comax price; priceWithTrailing is what Shopik
    // charges and displays (price + trailingPrice).
    trailingItemId: { type: String, filter: true },
    trailingItemQuantity: Number,
    trailingItemPrice: Number,
    trailingPrice: Number,
    priceWithTrailing: Number,
    isTrailingItem: { type: Boolean, filter: true },

    // Comax does not maintain a per-item VAT flag; the import derives it from
    // the category tree (departments named ללא מע"מ, plus fresh produce 13).
    vat: Boolean,
    // Shopik store ids (cash_register.storeId) this item is in stock in.
    // Written by the per-store HasInventory feed and the fresh-department feed.
    storeIds: { type: [String], filter: true },

    superDepartmentCode: String,
    departmentCode: String,
    groupCode: String,
    subGroupCode: String,
    superDepartment: { type: String, filter: true },
    department: { type: String, filter: true },
    group: { type: String, filter: true },
    subGroup: { type: String, filter: true },
    supplierId: String,
    // Comax SupplierName. The import writes `supplier` (see external/comax/
    // mapper.js), so this field name has to match it or the value is dropped
    // by the schema and never reaches the DB.
    supplier: { type: String, filter: true },
    manufacturerCode: String,
    manufacturer: String,

    height: Number,
    width: Number,
    length: Number,
    weight: Number,

    // raw Comax weight/size indicators → used to derive product.unit
    Size: String,
    SwWeighable: Boolean,
    Content: Number,
    ContentUnit: String,
    ContentMeasure: Number,
    QtyType: String,
    calories: Number,
    carbohydrates: Number,
    protein: Number,
    fat: Number,
    cholesterol: Number,
    alcohol: Boolean,

    picUrl: String,

    colors: [{ id: String, name: String, _id: false }],
    sizes: [{ id: String, name: String, _id: false }],
    models: [{ id: String, name: String, _id: false }],
    prices: [{ priceListId: String, price: Number, _id: false }],

    openDate: Date,
    archiveDate: Date,
    blockSalesDate: Date,
    blockPurchaseDate: Date,

    showInWeb: { type: Boolean, filter: true },
    archived: { type: Boolean, filter: true },

    fetchConfig: {
        storeId: String,
        priceListId: String,
        withOutArchive: Boolean
    },

    syncedAt: Date,
    lastImportedAt: Date,
    buyingPriceImportedAt: Date,
    // Set only by the catalog backfill (api/comax_product/backfill_catalog):
    // this row came from a per-item Comax lookup of the full catalog, not from a
    // store feed. It is never overwritten by an import, which keeps the two
    // sources distinguishable when a row looks wrong.
    backfilledAt: Date,
    // Latest sale of this barcode in any store, from the sales-window feed.
    // Informational: the per-store decision is storeIds (see salesWindow.js).
    lastSaleDate: Date,
    // Comax's SalesLastDays for this barcode, summed over the stores of the
    // sales-window feed. Units over the queried window (the widest configured
    // one), fractional for weighed goods. The sync copies it to
    // product.totalSalesUnits; missing means "never measured", which is not 0.
    salesLastDays: Number
}

export const meta = {
    index: [
        // The nightly sync updates batches by comaxId ($in) and the sale sync's $or
        // probes comaxId/models.id — unindexed, each was a full collscan of the
        // catalog per batch. storeIds covers the per-store distinct in the import.
        { comaxId: 1 },
        { 'models.id': 1 },
        { storeIds: 1 },
        // Admin filter options run distinct() over these; sales_window groups by
        // departmentCode — all were full collection scans without an index.
        { superDepartment: 1 },
        { department: 1 },
        // sales_window groups the whole catalog by {code: departmentCode, name:
        // department} with an isTrailingItem filter. Carrying exactly those three
        // keys makes the group a COVERED index scan: docsExamined 0 / 21 512 keys /
        // 4 ms instead of an IXSCAN+FETCH of all 21 514 documents / 52 ms
        // (explain on the prod copy). The planner picks it over {departmentCode}
        // even when both exist, but the old single-key index is now redundant —
        // drop it once this is live: db.comax_products.dropIndex("departmentCode_1")
        { departmentCode: 1, department: 1, isTrailingItem: 1 },
        // The category map reads a whole sub-group at a time: tree's $in over the
        // unassigned codes and the assign/apply metadata lookups scanned all 20 358
        // rows to return 101 (16 s).
        { subGroupCode: 1 },
        // reports/version.js fingerprints the catalog with the newest comax updatedAt
        // to decide whether a produced report file can be reused. With no index that
        // probe read every row and blocking-sorted it: 21 514 docs / 9 ms on the copy,
        // 24 401 docs / 141 ms and an in-memory sort on prod (Atlas's top comax hit).
        // products already carries the same pair for the same probe ({updatedAt, id});
        // the id tiebreaker also lets a DL read sorted by updatedAt stream from it.
        { updatedAt: -1, id: 1 }
    ]
}

export default comaxProductSchema
