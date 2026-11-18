const KINDS = {
    PRICE: 'price',
    PERCENT: 'percent',
    RECEIVE_AMOUNT: 'receive-amount',
    RECEIVE_PRICE: 'receive-price'
}
const TYPES = {
    PRODUCT: 'product',
    CART: 'cart'
}
const STATUS = {
    ACTIVE: 'active',
    CANCELED: 'canceled',
    DONE: 'done',
    PENDING: 'pending'
}
const notificationSchema = {
    icon: String,
    title: String,
    text: String,
    timeout: Number,
    color: String,
    iconBg: String,
    position: String,
    mobilePosition: String
}

const saleSchema = {
    status: {
        type: String,
        enum: Object.values(STATUS),
        filter: true
    },
    price: Number,
    // Comax's own total (before its trailing items). `price` is what Shopik
    // charges: the original total plus the deposits of the bundle. Stored so
    // the two can be reconciled.
    comaxPrice: Number,
    // Deposit total included in `price` (e.g. 3 bottles x 0.30 = 0.90).
    trailingTotal: Number,
    percent: Number,
    receive: {
        variety: Boolean, // the receive barcodes are idential to the sale.barcodes
        barcodes: [String],
        amount: Number,
        type: { type: String, enum: [KINDS.PERCENT, KINDS.PRICE] },
        percent: Number,
        price: Number,
        onAmountMod: Number,
        autoAdd: Boolean,
        notifications: {
            onReceive: notificationSchema,
            onEligible: notificationSchema,
            onLimit: notificationSchema
        },
        displayTexts: {}
    },
    name: {
        type: String,
        required: true,
        filter: true
    },
    displayName: {
        type: String,
        required: true
    },
    type: {
        type: String,
        enum: Object.values(TYPES),
        default: TYPES.PRODUCT,
        required: true
    },
    kind: {
        type: String,
        enum: Object.values(KINDS),
        required: true,
        filter: true
    },
    start: {
        type: Date,
        required: true,
        filter: true
    },
    end: {
        type: Date,
        required: true,
        filter: true
    },
    amount: {
        type: Number,
        required: true,
        default: 1,
        min: 1
    },
    limit: {
        type: Number
    },
    description: String,
    barcodes: {
        type: [String],
        required: true
    },
    numOfProducts: Number,
    filter: {
        field: String,
        fieldValue: String,
        subfield: String,
        subfieldValues: [String]
    },
    promotion: {
        desktopImg: String,
        mobilewebImg: String,
        androidImg: String,
        iosImg: String,
        saleSEOName: {
            type: String
        },
        showLinkToSale: {
            type: Boolean,
            default: false
        }
    },
    priority: { type: Number, default: 1 },
    display: {
        headerStrip: {
            imgUrl: String,
            text: String,
            addShadow: Boolean
        },
        productHeader: {
            text: String
        }
    },
    createdBy: String,
    updatedBy: String,
    cancelDate: Date,
    canceledBy: String
}

const defaultSelect = {
    _id: 0,
    id: 1,
    name: 1,
    displayName: 1,
    type: 1,
    kind: 1,
    status: 1,
    start: 1,
    end: 1,
    amount: 1,
    limit: 1,
    price: 1,
    percent: 1,
    barcodes: 1,
    receive: 1
}

export const meta = {
    defaultSelect,
    constants: {
        KINDS,
        TYPES,
        STATUS
    },
    index: [
        // displayBlocks.resolveCarouselFilter's distinct of active sale ids runs
        // on every onSale carousel request, and status had no index: the distinct
        // read every sale ever made (5847 docs for 902 ids). With {status, id} it
        // is covered — keys only, no document fetch.
        { status: 1, id: 1 },
        // A status-scoped read sorted by updatedAt (Atlas: 6 460 docs examined for 30
        // returned, in-memory sort every run). {status, id} can carry the filter or
        // the id list, never the sort, so the planner read every sale ever made.
        { status: 1, updatedAt: -1, id: 1 }
    ]
}

export default saleSchema