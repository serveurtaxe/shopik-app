import uid from '#common/functions/uid.js'
import Counter from '../models/counter.js'
import { constants as productConstants } from './product.js'
import { constants as storeConstants } from './store.js'
const { DELIVERY_METHOD } = storeConstants

const CART_PRODUCT_STATUS = {
    ADMIN_ADD: 'admin_add',
    CLIENT_ADD: 'client_add'
}


const CASH_REGISTER_STATUS = {
    PENDING: 'pending',
    FAILED: 'failed',
    SUCCESS: 'success'
}

const USER_APPROVAL = {
    KOSHER_PENDING: 'kosher-pending',
    KOSHER_APPROVED: 'kosher-approved'
}

const OWNER_STATUS = {
    ACTIVE: 'active',
    READY: 'ready',
    PAUSE: 'pause',
    ON_HOLD: 'on-hold',
    FREE: 'free',
    CUSTOMER_PENDING: 'customer-pending',
    CUSTOMER_APPROVED: 'customer-approved',
    MANAGER_PENDING: 'manager-pending',
    MANAGER_APPROVED: 'manager-approved',
    MANAGER_EXCEPTIONS: 'manager-exceptions',
    DONE: 'done'
}

const ORDER_STATUS = {
    CART: 'cart',
    PAID_EDIT: 'paid-edit',
    PAID: 'paid',
    PICKING: 'picking',
    PICKED: 'picked',
    PACKED: 'packed',
    SHIPPED: 'shipped',
    DONE: 'done',
    CANCELED: 'canceled',
    FAILED: 'failed'
}

const PICKUP_STATUS = {
    PENDING: 'pending',
    ON_THE_WAY: 'on-the-way',
    ARRIVED: 'arrived',
    DONE: 'done'
}

const constants = {
    CASH_REGISTER_STATUS,
    USER_APPROVAL,
    OWNER_STATUS,
    ORDER_STATUS,
    PICKUP_STATUS,
    CART_PRODUCT_STATUS,
    DELIVERY_METHOD
}

const invoiceSchema = {
    number: String,
    url: String,
    shortUrl: String
}

const priceDistributionSchema = {
    type: { type: String }, // sale / regular
    totalSum: Number,
    amount: Number,
    saleName: String,
    salePrice: Number,
    saleLimit: Number,
    saleId: String,
    saleKind: String,
    saleAmount: Number
}

const adminSchema = {
    adminId: String,
    name: String
}

const windowSchema = {
    id: String,
    date: { type: String, filter: true },
    start: Number,
    end: Number,
    reservedAt: Date,
    startTimestamp: Date,
    endTimestamp: Date,
    leadTimestamp: Date
}

const replacementSuggestionsSchema = {
    barcode: String,
    amount: Number,
    approval: {
        admin: adminSchema,
        user: { userId: String, name: String },
        time: Date
    }
}

const noteGroupSchema = {
    noteGroupName: String,
    noteGroupTag: String,
    name: String,
    options: [{
        id: String,
        text: String,
        value: String
    }]
}

const unitOptionSchema = {
    key: String, // small | medium | large
    name: String, // e.g. 'גדול (כ-10 ק"ג)'
    amount: Number // weight in baseUnit, e.g. 10 (kg)
}

export const cartSchema = [{
    id: String,
    name: String,
    barcode: String,
    amount: Number,
    finalAmount: Number,
    price: Number,
    totalSum: Number,
    regularSum: Number,
    saleSum: Number,
    saleIds: [String],
    status: {
        type: String,
        enum: Object.values(CART_PRODUCT_STATUS)
    },
    priceDistribution: [priceDistributionSchema],
    replacement: {
        suggestions: [replacementSuggestionsSchema],
        originalBarcode: String, // on the replacing product
        replacementBarcode: String // on the replaced product
    },
    missing: Boolean,
    missingReason: String,
    updatedAt: Date,
    userApproval: {
        type: String,
        enum: Object.values(USER_APPROVAL)
    },
    admins: [{
        adminId: String,
        date: {
            type: Date,
            default: Date.now
        },
        amount: Number,
        missing: Boolean,
        status: String
    }],
    storageType: String,
    alert: {},
    selectedNoteGroups: [noteGroupSchema],
    unit: {
        type: {
            type: String,
            enum: Object.values(productConstants.UNIT)
        },
        baseUnit: {
            type: String,
            enum: Object.values(productConstants.BASE_UNIT)
        },
        minAmount: Number,
        step: Number,
        units: Number, // count of units ordered (e.g. 2 watermelons)
        option: unitOptionSchema
    },
    // important product snapshot for display in cart / admin pick
    images: {
        product: [{
            main: Boolean,
            sourceUrl: String,
            hash: String,
            sizes: { xl: String, l: String, m: String, s: String },
            _id: false
        }],
        threeSixty: [String]
    },
    label: String,
    producer: String,
    category: {
        id: String,
        title: String,
        pathIds: [String]
    },
    picking: {
        recommendations: String,
        minShelflife: Number,
        allowBarcodeTypeIn: Boolean
    },
    shelfLife: Number,
    shelfLifeDate: Date,
    refundedAmount: { type: Number, default: 0 },
    supplierPrice: Number,
    supplierSum: Number
}]

const orderSchema = {
    domainId: String,
    storeId: { type: String, filter: true },
    storeName: String,
    userId: { type: String, filter: true },
    cart: cartSchema,
    sales: Object,
    time: {
        type: Date,
        default: Date.now
    },
    address: {
        areaId: String,
        city: String,
        street: String,
        building: Number,
        apartment: Number,
        entrance: String,
        floor: String,
        location: {
            type: { type: String, enum: ['Point'] },
            coordinates: { type: [Number], default: undefined }
        },
        comment: String,
        residenceType: String
    },
    deliveryMethod: {
        type: String,
        enum: Object.values(DELIVERY_METHOD),
        default: DELIVERY_METHOD.DELIVERY,
        filter: true
    },
    window: windowSchema,
    pickBy: Date,
    shipBy: Date,
    phone: String,
    secondPhone: String,
    email: String,
    name: {
        first: String,
        last: String
    },
    status: {
        type: String,
        enum: Object.values(ORDER_STATUS),
        default: ORDER_STATUS.CART,
        filter: true
    },
    sum: {
        type: Number,
        default: 0
    },
    sumNoCoupon: Number,
    finalSum: Number,
    finalSumNoCoupon: Number,
    coupons: [{
        code: String,
        discount: Number,
        appliedDiscount: Number,
        originalDiscount: Number,
        benefit: String,
        percent: Boolean,
        minSum: Number,
        maxSum: Number,
        isActive: Boolean,
        whitelist: [String],
        blacklist: [String],
        condition: Object,
        couponMessages: {
            sectionMessage: {
                text: String
            },
            checkOutMessage: {
                icon: String,
                title: String,
                text: String
            }
        },
        checkOnPay: Boolean
    }],
    number: {
        type: String,
        unique: true,
        required: true,
        filter: true
    },
    replaceProducts: {
        type: Boolean,
        default: false
    },
    replaceProductsNoCall: {
        type: Boolean,
        default: false
    },
    leaveOrderAtDoor: {
        type: Boolean,
        default: false
    },
    paid: {
        type: Boolean,
        default: false,
        filter: true
    },
    payment: {
        provider: { type: String, default: 'hyp' },
        providerTxnId: String,
        authCode: String,
        providerUid: String,
        providerPayerId: String,
        cardToken: String,
        cardExpiry: String,
        last4digits: String,
        cardCompany: String,
        terminalId: String,
        authorizedAmount: Number,
        capturedAt: Date,
        captureProviderTxnId: String
    },
    refundedTotal: { type: Number, default: 0 },
    refundedShipping: { type: Number, default: 0 },
    // Remainder owed to the customer after a cancel-through (provider declined
    // the zikoy): the order shows canceled, an auto-retry cron keeps attempting
    // the zikoy (refundPendingAttempts counts tries), finance can credit manually
    // via Hyp Console and register it via payment/refund { manual: true }.
    refundPending: { type: Number, default: 0 },
    refundPendingAttempts: { type: Number, default: 0 },
    invoice: invoiceSchema,
    receipt: {
        url: String,
        shortUrl: String,
    },
    storeProductListUrl: String,
    paidAt: Date,
    paidOrderUpdatedAt: Date,
    paymentError: String,
    invoiceError: String,
    supplierTotal: Number,
    supplierMissingCount: { type: Number, default: 0 },
    supplierCapturedAt: Date,
    comaxDoc: {
        docNumber: { type: String, filter: true },
        totalSum: Number,
        capturedAt: Date,
        error: String
    },
    cancelReason: String,
    pickTargetDuration: Number,
    pickStart: Date,
    pickEnd: Date,
    finalSumAfterRefunds: Number,
    comment: String,
    origin: {
        client: String,
        platform: String,
        os: String,
        device: String,
        browser: String
    },
    paymentAttempts: { type: Number, default: 0 },
    orderPickupToken: { type: String, default: () => uid() },
    notifications: {
        userOnTheWay: { type: Number, default: 0 },
        userArrived: { type: Number, default: 0 },
        notifyUserSms: { type: Number, default: 0 }
    },
    deliveryDetails: {
        clientETA: Date,
        clientArrivalState: {
            type: String,
            enum: Object.values(PICKUP_STATUS),
            default: 'pending'
        },
        deliveryDate: Date
    },
    picker: adminSchema,
    pickFinalizer: adminSchema,
    shipper: adminSchema,
    orderFinalizer: adminSchema,
    supplyPassoverProductsOnly: { type: Boolean, default: false },
    tempCartId: String,
    customerUpdatedAt: Date,
    originalSum: Number,
    sumWithShipping: Number,
    finalSumWithShipping: Number,
    shipping: Number,
    finalShipping: Number,
    updateReason: String,
    userOrderNumber: Number,
    orderRestoredFrom: {
        orderNumber: Number,
        orderId: String,
        restoredAt: Date,
        adminId: String
    },
    orderRestoredTo: [
        {
            orderNumber: Number,
            orderId: String,
            restoredAt: Date,
            adminId: String
        }
    ],
    cancelDate: Date,
    firstCheckoutDate: Date,
    productStorage: {
        regular: { type: Number, default: 0 },
        cold: { type: Number, default: 0 },
        freeze: { type: Number, default: 0 },
        extra: { type: Number, default: 0 }
    },
    bags: {
        regular: { type: Number, default: 0 },
        cold: { type: Number, default: 0 },
        freeze: { type: Number, default: 0 },
        extra: { type: Number, default: 0 }
    },
    boxes: {
        cold: Number,
        freeze: Number,
        amount: {
            type: Number,
            min: 1
        },
        external: Number,
        crate: Number,
        cooler: Number
    },
    printInfo: {
        count: {
            type: Number,
            default: 0
        },
        data: [String]
    },
    labels: [{
        _id: false,
        name: String,
        label: String,
        style: {
            backgroundColor: String,
            color: String,
            iconName: String
        }
    }],
    messages: [{
        _id: false,
        phone: String,
        messageId: String,
        type: { type: String, default: 'notification', enum: ['sms', 'notification'] },
        message: String,
        date: { type: Date, default: Date.now },
        source: String,
        adminId: String
    }],
    archiveInfo: {
        userDeleteRequest: Boolean,
        userDeleteRequestDate: Date,
        restoredUser: Boolean,
        restoredAt: Date
    },
    shipperComment: String,
    shipmentId: String,
    deliveryProof: {
        url: String,
        at: Date
    },
    pickingReleaseCount: Number,
}

const virtuals = {
    displayComment: function () {
        const commentFirstStatus = ['paid', 'pick', 'paid-edit', 'cart']
        return this.address && this.address.comment ?
            (this.comment ?
                (commentFirstStatus.includes(this.status) ?
                    `${this.comment} ${this.address.comment}` :
                    `${this.address.comment} ${this.comment}`
                ) :
                this.address.comment)
            : this.comment
    }
}

const counterName = 'order-number-counter'
const methods = Order => ({
    getNumber: async function () {
        const nextNumber = await Counter.findOneAndUpdate(
            { name: counterName },
            { $inc: { value: 1 } },
            {
                upsert: true,
                setDefaultsOnInsert: true,
                returnDocument: 'after'
            }
        ).lean()
        return nextNumber?.value
    }
})

const defaultSelect = {
    _id: 0,
    id: 1,
    number: 1,
    status: 1,
    sum: 1,
    sumWithShipping: 1,
    shipping: 1,
    finalSum: 1,
    finalSumWithShipping: 1,
    finalShipping: 1,
    sumNoCoupon: 1,
    websiteCart: 1,
    cart: 1,
    coupons: 1,
    orderPickupToken: 1,
    deliveryMethod: 1,
    address: 1,
    storeId: 1,
    window: 1,
    domainId: 1
}

const index = [
    { storeId: -1 },
    { userId: -1 },
    { 'window.date': 1 },
    { status: 1 },
    { deliveryMethod: 1 }
]

export const meta = {
    index,
    constants,
    virtuals,
    methods,
    defaultSelect
}

export default orderSchema