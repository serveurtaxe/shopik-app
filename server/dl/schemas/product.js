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
        search: 50,
        searchPrefixBoost: 60,
        searchFuzzy: 3,
        filter: true
    },
    // Set when a human chose the name (admin edit or the barcode-alias import).
    // Comax and GS1 keep enriching every other field but never overwrite a
    // locked name — supplier copy changes the catalog without asking.
    nameLocked: { type: Boolean, default: false },
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
    buyingPrice: Number,
    // Derived from the Comax category tree at import time (departments named
    // ללא מע"מ, plus fresh produce). Classification is owned by Comax: the
    // nightly sync rewrites it, so there is deliberately no manual override.
    vat: { type: Boolean, default: true, filter: true },
    barcode: {
        type: String,
        unique: true,
        required: true,
        trim: true,
        // 'exact': a barcode is a whole value, and the prefix form processFilter
        // builds for a plain String filter turns a unique lookup into a scan of the
        // whole barcode index (see dl/schemas/comax_product.js).
        filter: 'exact'
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
    // Last scrape attempt with no usable candidate (any provider). Keeps
    // bulk backfills O(n): --imageless skips tried docs unless --retry-failed.
    scrapeTriedAt: Date,
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
    saleIds: { type: [String], filter: true },
    sortOrder: {
        type: Number,
        min: 0,
        max: 5,
        default: 1
    },
    limit: Number,
    keywords: {
        type: [{ trim: true, type: String }],
        search: 5,
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
    // Normalized GS1 Diet_Information claims ({ code, name }). Drives the diet
    // icons on the card + product page. Mapped by server/external/gs1/mapper.js.
    diet: [{
        code: String,
        name: String,
        _id: false
    }],
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
            search: 2,
            filter: true
        },
        pathIds: { type: [String], index: true, filter: true }
    },
    // Raw Comax sub-group code. Kept next to the resolved category so the admin
    // can reassign a whole sub-group with one update and coverage stays cheap.
    // filter: 'exact' — always looked up by whole code. The prefix form processFilter
    // builds for a plain String filter made '1370' match '13701', and a
    // case-insensitive regex can never use the {status, comaxSubGroupCode} index.
    comaxSubGroupCode: { type: String, filter: 'exact' },
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
        enum: Object.values(constants.STATUS),
        default: constants.STATUS.ACTIVE,
        filter: true
    },
    hint: String,
    totalSalesUnits: { // used for sorting - should take the last X months of sales units
        type: Number,
        default: 0
    },
    netContentText: String
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
    diet: 1,
    limit: 1,
    label: 1,
    producer: 1,
    nutrients: 1,
    unit: 1,
    saleIds: 1,
    netContentText: 1,
    vat: 1
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
    // Unique tiebreaker: sortOrder/totalSalesUnits tie for most products, and
    // without a unique key skip/limit pagination returns overlapping pages.
    id: 1,
}

// Popularity nudge applied to search relevance (see dl/defaults/search.js).
// Points grow with log10 of sales units, so 10 units → +10, 100 → +20,
// 1000+ → +30 (capped). The cap keeps a best seller from outranking a
// name-prefix match; the nudge only breaks close text-relevance decisions.
const searchBoost = {
    path: 'totalSalesUnits',
    multiplier: 100,
    cap: 1000
}

export const meta = {
    constants,
    defaultSelect,
    defaultSelectOne,
    defaultSort,
    searchBoost,
    index: [
        { storeIds: 1, status: 1 },
        // Carries defaultSort as its suffix: category pages filter by status +
        // pathIds and sort by sortOrder/totalSalesUnits/id. With only the two
        // filter keys the planner picked this index for selectivity and then
        // blocked on an in-memory sort of every matching doc (823 ms, 694 docs).
        // The {status, pathIds} prefix still covers distinct() and the menu reads.
        { status: 1, 'category.pathIds': 1, sortOrder: -1, totalSalesUnits: -1, id: 1 },
        { status: 1, comaxSubGroupCode: 1 },
        { status: 1, 'prices.domainId': 1, sortOrder: -1, totalSalesUnits: -1, id: 1 },
        { status: 1, 'prices.domainId': 1, totalSalesUnits: -1, id: 1 },
        { status: 1, 'prices.domainId': 1, createdAt: -1, id: 1 },
        { updatedAt: 1, id: -1 },
        // sale/sync's stale-saleIds sweep (distinct barcode where saleIds non-empty):
        // sparse keeps the scan bounded to products that actually carry a sale.
        [{ saleIds: 1 }, { sparse: true }]
    ]
}

export default productSchema