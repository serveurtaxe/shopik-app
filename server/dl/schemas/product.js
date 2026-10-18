import mongoose from 'mongoose'

export const constants = {
    PASSOVER_KASHRUT: {
        NOT_RELEVANT: 'not-relevant',
        KOSHER: 'kosher',
        NOT_KOSHER: 'not-kosher',
        SPECIAL: 'special'
    },
    UNIT: {
        ITEM: 'item',
        WEIGHT: 'weight',
        PACK: 'pack'
    },
    BASE_UNIT: {
        KG: 'kg',
        G: 'g',
        UNIT: 'unit'
    },
    STORAGE_TYPE: {
        REGULAR: 'regular',
        COLD: 'cold',
        FREEZE: 'freeze',
        EXTRA: 'extra'
    },
    STATUS: {
        ACTIVE: 'active', // available everywhere
        HIDDEN: 'hidden', // available in admin for replacements only
        ARCHIVED: 'archived' // available only to show in old orders
    }
}

const productSchema = {
    name: {
        type: String,
        required: true,
        trim: true,
        search: 30,
        searchPrefixBoost: 100,
        searchFuzzy: 3,
        filter: true
    },
    description: String,
    regulatoryInfo: String,
    prices: {
        type: [{
            domainId: { type: String, filter: true },
            price: Number,
            _id: false
        }],
        validate: {
            validator: async function (prices) {
                if (!prices?.length)
                    throw new Error('Prices cannot be empty')
                const validPrices = prices.every(p => p.price >= 0 && p.domainId)
                if (!validPrices)
                    throw new Error('invalid prices')
                const domainIds = [...new Set(prices.map(p => p.domainId))]
                const domainCount = await mongoose.model('Domain')
                    .countDocuments({ id: { $in: domainIds } })
                if (domainIds.length != domainCount)
                    throw new Error('invalid domain id')
                return true
            }
        }
    },
    barcode: {
        type: String,
        unique: true,
        required: true,
        trim: true,
        filter: true
    },
    scannableBarcodes: {
        type: [String],
        default: [],
        index: true
    },
    externalSerialNumber: {
        type: String,
        trim: true
    },
    gs1ProductCode: {
        type: String,
        trim: true,
        index: true,
        filter: true
    },
    gs1SyncedAt: Date,
    // Mapped GS1 extras (defined keys, flexible leaves — full payload stays in gs1_products).
    gs1: {
        netContent: {},
        origin: [{}],
        dimensions: {},
        shelfLife: {},
        allergens: {},
        diet: [{}],
        serving: {},
        nutrition: {},
        marketing: {},
        eu: {},
        ids: {}
    },
    label: {
        type: String,
        trim: true,
        search: 8,
        searchPrefixBoost: 15,
        searchFuzzy: 1,
        filter: true
    },
    producer: {
        type: String,
        trim: true,
        filter: true
    },
    picking: {
        recommendations: String,
        minShelflife: Number,
        allowBarcodeTypeIn: Boolean
    },
    unit: {
        type: {
            type: String,
            enum: Object.values(constants.UNIT),
            default: constants.UNIT.ITEM
        },
        baseUnit: {
            type: String,
            enum: Object.values(constants.BASE_UNIT),
            default: constants.BASE_UNIT.UNIT
        },
        minAmount: {
            type: Number,
            default: 1
        },
        step: {
            type: Number,
            default: 1
        },
        options: [{
            key: String, // small | medium | large
            name: String, // label, e.g. 'גדול (כ-10 ק"ג)'
            amount: Number // weight in baseUnit, e.g. 10 (kg)
        }]
    },
    saleIds: { type: [String], filter: true, index: true },
    sortOrder: {
        type: Number,
        min: 0,
        max: 5,
        default: 1
    },
    limit: Number,
    keywords: {
        type: [{ trim: true, type: String }],
        search: 2,
        filter: true
    },
    googleCategory: String,
    storeIds: { type: [String], filter: true },
    kashrut: {
        // GS1 rabbinates (code drives ranking + stamp image, name is the
        // display fallback) and the Kosher_Supervision_Type food-category code
        // (labelled client-side). Mapped by server/external/gs1/mapper.js.
        rabbinates: {
            type: [{
                code: String,
                name: String,
                _id: false
            }]
        },
        supervisionType: String
    },
    passoverKashrut: {
        type: String,
        enum: Object.values(constants.PASSOVER_KASHRUT)
    },
    scannable: { type: Boolean, default: true },
    nutrients: {
        positive: Boolean,
        sugar: Boolean,
        sodium: Boolean,
        fat: Boolean,
        alcohol: Boolean
    },
    storageType: {
        type: String,
        enum: Object.values(constants.STORAGE_TYPE),
        default: constants.STORAGE_TYPE.REGULAR
    },
    shelflife: Number,
    category: {
        id: { type: String, filter: true },
        title: {
            type: String,
            search: 5,
            filter: true
        },
        pathIds: { type: [String], index: true, filter: true }
    },
    images: {
        product: [{
            main: Boolean,
            sourceUrl: String,
            hash: String,
            sizes: { xl: String, l: String, m: String, s: String }
        }],
        threeSixty: [String]
    },
    status: {
        type: String,
        index: true,
        enum: Object.values(constants.STATUS),
        default: constants.STATUS.ACTIVE,
        filter: true
    },
    hint: String,
    totalSalesUnits: { // used for sorting - should take the last X months of sales units
        type: Number,
        default: 0
    }
}

const defaultSelect = {
    _id: 0,
    id: 1,
    barcode: 1,
    name: 1,
    description: 1,
    'images.product': 1,
    noteGroupTags: 1,
    prices: 1,
    passoverKashrut: 1,
    kashrut: 1,
    limit: 1,
    label: 1,
    producer: 1,
    nutrients: 1,
    unit: 1,
    saleIds: 1
}

const {
    'images.product': _imgProduct,
    'images.mainIndex': _imgMainIndex,
    ...defaultSelectBase
} = defaultSelect

const defaultSelectOne = {
    ...defaultSelectBase,
    images: 1,
    gs1: 1,
    regulatoryInfo: 1,
    storageType: 1,
    shelflife: 1,
    category: 1,
    status: 1,
    totalSalesUnits: 1
}

const defaultSort = {
    sortOrder: -1,
    totalSalesUnits: -1,
}

export const meta = {
    constants,
    defaultSelect,
    defaultSelectOne,
    defaultSort,
    index: [
        { storeIds: 1 },
        { status: 1, 'category.pathIds': 1 },
        { status: 1, 'prices.domainId': 1 }
    ]
}

export default productSchema