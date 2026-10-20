import { CACHE_STRATEGIES } from '#common/constants.js'

const comaxProductSchema = {
    comaxId: String,
    barcode: { type: String, required: true, unique: true, filter: true },

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

    superDepartmentCode: String,
    departmentCode: String,
    groupCode: String,
    subGroupCode: String,
    superDepartment: { type: String, filter: true },
    department: { type: String, filter: true },
    group: { type: String, filter: true },
    subGroup: { type: String, filter: true },
    supplierId: String,
    supplierName: String,
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
    buyingPriceImportedAt: Date
}

export default comaxProductSchema
