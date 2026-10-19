export const constants = {
    KIND: {
        BANNER: 'banner',
        PRODUCT_CAROUSEL: 'product_carousel'
    },
    PLACEMENT: {
        PATH: 'path',
        CATEGORY: 'category'
    },
    LAYOUT: {
        MOSAIC: 'mosaic',
        CAROUSEL: 'carousel'
    }
}

// One image, stored as a relative object base path (no size suffix, no host):
//   images/display-blocks/<blockId>/<slideKey>/<desktop|mobile>/<size>.webp
// Resolved client-side via common/functions/displayImageUrl.js + VITE_FILES_BASE_URL.
const slideSchema = {
    // Stable client-generated id: row keys + GCS slideKey across reorders.
    key: String,
    image: String,
    mobileImage: String,
    link: String,
    alt: String,
    _id: false
}

const displayBlockSchema = {
    kind: {
        type: String,
        enum: Object.values(constants.KIND),
        required: true,
        filter: 'exact'
    },
    name: {
        type: String,
        required: true,
        trim: true,
        filter: true
    },
    // Shopper-facing title — carousels only (banners are just linked images).
    title: {
        type: String,
        trim: true
    },
    // Blocks are always domain-scoped — no "all domains" fallback.
    // Exact: prefix match would let one domainId match another's prefix.
    domainId: {
        type: String,
        required: true,
        filter: 'exact'
    },
    // Single placement per block: to show the same content on two pages,
    // duplicate the block. This keeps one order sequence per page.
    placement: {
        type: {
            type: String,
            enum: Object.values(constants.PLACEMENT),
            required: true
        },
        // Exact: prefix match makes '/' match '/sales' (see processFilter).
        path: { type: String, filter: 'exact' },
        categoryId: { type: String, filter: 'exact' },
        includeSubcategories: { type: Boolean, default: false }
    },
    order: {
        type: Number,
        default: 0
    },
    schedule: {
        start: Date,
        end: Date
    },
    banner: {
        layout: {
            type: String,
            enum: Object.values(constants.LAYOUT),
            default: constants.LAYOUT.CAROUSEL
        },
        autoplaySec: { type: Number, default: 5, min: 0 },
        slides: [slideSchema]
    },
    carousel: {
        // Curated filter, replayed through the product/get code path.
        filter: {
            categoryId: String,
            onSale: Boolean,
            search: String,
            barcodes: [String]
        },
        // Validated server-side against an allowlist (see api/display_block/get.js).
        sort: {},
        limit: { type: Number, default: 20, min: 1, max: 100 },
        autoplaySec: { type: Number, default: 0, min: 0 },
        showAll: { type: Boolean, default: true },
        // Custom "show all" link text — storefront falls back to הצג הכל.
        showAllText: { type: String, trim: true }
    }
}

const defaultSelect = {
    _id: 0,
    id: 1,
    kind: 1,
    name: 1,
    title: 1,
    domainId: 1,
    placement: 1,
    order: 1,
    schedule: 1,
    banner: 1,
    carousel: 1,
    active: 1,
    createdAt: 1,
    updatedAt: 1
}

export const meta = {
    constants,
    defaultSelect,
    defaultSelectOne: defaultSelect,
    index: [
        { domainId: 1, active: 1, 'placement.path': 1, order: 1 },
        { domainId: 1, active: 1, 'placement.categoryId': 1, order: 1 }
    ]
}

export default displayBlockSchema
