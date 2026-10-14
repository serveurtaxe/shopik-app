import regex from "#common/functions/regex.js"

const otpSchema = {
    phone: {
        type: String,
        required: true,
        match: regex.mobilePhone
    },
    otp: { type: String, required: true },
    token: { type: String, required: true },
    userId: String,
    remember: Boolean,
    attempts: { type: Number, default: 0 },
    payload: Object
}

const index = [
    [
        { createdAt: 1 },
        { expireAfterSeconds: 10 * 60 }
    ],
    { phone: 1, token: 1 }
]

export const meta = {
    index,
    noActive: true,
    noId: true
}

export default otpSchema