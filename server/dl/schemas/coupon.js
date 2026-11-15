const DEPARTMENTS = {
    MARKETING: 'marketing',
    LOGISTICS: 'logistics',
    CUSTOMER_SERVICE: 'customer-service',
    FINANCE: 'finance'
}
const BENEFITS = {
    SUM: 'sum',
    PERCENT: 'percent'
}
const STATUS = {
    ACTIVE: 'active',
    CANCELED: 'canceled'
}

const couponSchema = {
    code: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
        unique: true,
        filter: true
    },
    name: {
        type: String,
        required: true,
        filter: true
    },
    description: String,
    department: {
        type: String,
        enum: Object.values(DEPARTMENTS),
        required: true,
        default: DEPARTMENTS.MARKETING,
        filter: true
    },
    discount: {
        type: Number,
        required: true
    },
    minSum: {
        type: Number,
        required: true
    },
    maxSum: Number,
    // A personal coupon belongs to a single customer: it is canceled after the
    // first paid use. Non-personal coupons stay usable by other customers but
    // every customer is still blacklisted after their own use.
    personal: {
        type: Boolean,
        default: false,
        filter: true
    },
    benefit: {
        type: String,
        required: true,
        enum: Object.values(BENEFITS),
        filter: true
    },
    whitelist: [String],
    blacklist: [String],
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
    dynamic: {
        type: Boolean,
        default: false
    },
    condition: {
        orderRange: {
            start: Number,
            end: Number
        },
        lastOrder: {
            start: Date,
            end: Date
        },
        cities: [String],
        emails: [String],
        phones: [String],
        creditCardCompanies: [{
            _id: false,
            name: String,
            firstDigits: String
        }]
    },
    campaignName: String,
    public: {
        type: Boolean,
        default: false,
        filter: true
    },
    status: {
        type: String,
        default: STATUS.ACTIVE,
        enum: Object.values(STATUS),
        filter: true
    },
    adminId: {
        type: String,
        required: true
    }
}

export const meta = {
    constants: {
        DEPARTMENTS,
        BENEFITS,
        STATUS
    }
}

export default couponSchema