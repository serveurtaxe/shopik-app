import { CACHE_STRATEGIES } from '#common/constants.js'
import { constants as storeConstants } from './store.js'
const { DELIVERY_METHOD } = storeConstants
import uid from '#common/functions/uid.js'
import regex from '#common/functions/regex.js'
const RESIDENCE = {
    PRIVATE: 'private',
    APARTMENT: 'apartment'
}
const addressSchema = {
    _id: false,
    name: String,
    active: {
        type: Boolean,
        default: false
    },
    addressId: {
        type: String,
        default: uid
    },
    areaId: String,
    city: {
        type: String,
        required: true,
        filter: true
    },
    street: {
        type: String,
        required: true,
        filter: true
    },
    building: {
        type: Number,
        required: true,
        min: [1, 'building must be bigger than 0']
    },
    floor: String,
    hasElevator: {
        type: Boolean,
        default: true
    },
    apartment: Number,
    entrance: {
        type: String,
        default: 0
    },
    entranceCode: String,
    navigateToAddress: Boolean,
    location: {
        type: { type: String, default: 'Point', enum: ['Point'] },
        coordinates: [Number]
    },
    comment: String,
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    residenceType: {
        type: String,
        enum: Object.values(RESIDENCE)
    },
    hasService: Boolean,
    accuracy: String
}

const creditCardSchema = {
    fourDigits: {
        type: String,
        required: true,
        match: regex.card
    },
    token: {
        type: String,
        required: true,
        select: false
    },
    company: {
        type: String
    },
    exp: {
        type: String,
        required: true,
        select: false
    },
    enabled: {
        type: Boolean,
        default: true
    }
}

const tokenSchema = {
    token: String,
    expires: Date
}

const tokensSchema = {
    web: tokenSchema,
    web_mobile: tokenSchema,
    web_app: tokenSchema,
    bot: tokenSchema
}

const userSchema = {
    email: {
        type: String,
        match: regex.email,
        lowercase: true,
        filter: true,
        userEditable: true
    },
    lastLogin: {
        type: Date,
        default: Date.now
    },
    lastLogout: Date,
    phone: {
        type: String,
        required: true,
        match: regex.mobilePhone,
        filter: true,
        userEditable: true
    },
    secondPhone: {
        type: String,
        filter: true,
        userEditable: true
    },
    name: {
        first: {
            type: String,
            match: regex.name,
            trim: true,
            filter: true,
            userEditable: true
        },
        last: {
            type: String,
            match: regex.name,
            trim: true,
            filter: true,
            userEditable: true
        }
    },
    addresses: [addressSchema],
    creditCards: [creditCardSchema],
    getOffers: {
        type: Boolean,
        default: false,
        userEditable: true
    },
    replaceProducts: {
        type: Boolean,
        default: false,
        userEditable: true
    },
    notAtHome: {
        type: Boolean,
        default: false,
        userEditable: true
    },
    comments: {
        type: [{
            comment: String,
            date: Date,
            creator: { id: String, name: String, phone: String }
        }],
        select: false
    },
    tokens: {
        type: tokensSchema,
        select: false
    },
    deliveryMethod: {
        type: String,
        enum: Object.values(DELIVERY_METHOD),
        default: DELIVERY_METHOD.DELIVERY
    },
    pickupStoreId: String,
    noMinOrderSum: Boolean, // do not enforce minimum order sum
    sendTaxInvoiceToEmail: Boolean,
    privacyPolicyValidationRequired: { type: Boolean, default: true },
    termsValidationRequired: { type: Boolean, default: true },
    isTestUser: Boolean,
    domainId: String,
    blocked: Boolean
}

const defaultSelect = {
    _id: 0,
    id: 1,
    name: 1,
    phone: 1,
    email: 1,
    addresses: 1,
    deliveryMethod: 1,
    pickupStoreId: 1,
    getOffers: 1,
    domainId: 1
}

export const meta = {
    defaultSelect,
    cacheStrategy: CACHE_STRATEGIES.VERSION,
    index: [
        [{ domainId: 1, phone: 1 }, { unique: true }]
    ]
}

export default userSchema