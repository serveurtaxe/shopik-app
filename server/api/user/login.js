import { USER_TOKEN_EXPIRY_MS, USER_TOKEN_EXPIRY_SHORT_MS, USER_TOKEN_COOKIE, GUEST_CART_TOKEN_COOKIE } from '#common/constants.js'
import toRemember from '#common/functions/toRemember.js'

export default async function login({ domainId, phone, otpToken, otp, remember }, { DL, utils, platform, setCookie, cookies, clearCookie }) {
    const storedOtp = await DL.Otp.readOne({ token: otpToken })
    if (!storedOtp || storedOtp.otp !== otp || String(storedOtp.phone) !== String(phone)) {
        if (storedOtp?._id) {
            const attempts = (storedOtp.attempts || 0) + 1
            if (attempts >= 5) {
                await DL.Otp.deleteOne({ _id: storedOtp._id })
                throw { message: 'Too many failed attempts. Code expired.', status: 403 }
            }
            await DL.Otp.updateOne({ _id: storedOtp._id }, { attempts })
        }
        throw { message: 'invalid OTP', status: 403 }
    }

    let user

    if (storedOtp.payload) {
        user = await DL.User.create(storedOtp.payload)
    } else {
        // Resolve against the number the OTP was issued to, never the client-supplied one.
        user = await DL.User.readOne({ domainId, phone: storedOtp.phone })
        if (!user)
            throw { message: 'login failed', status: 403 }
    }

    const shouldRemember = toRemember(remember) || (remember === undefined && toRemember(storedOtp.remember))
    const tokenExpiryMs = shouldRemember ? USER_TOKEN_EXPIRY_MS : USER_TOKEN_EXPIRY_SHORT_MS
    const token = utils.auth.createToken(user.id, tokenExpiryMs)
    const update = {
        lastLogin: new Date,
        [`tokens.${platform}`]: token
    }
    const updatedUser = await DL.User.updateOne({ id: user.id }, update, { select: DL.User.defaultSelect })

    await DL.redis?.del(`user_auth:${user.id}`)
    await DL.Otp.deleteOne({ _id: storedOtp._id })
    setCookie(USER_TOKEN_COOKIE, token, tokenExpiryMs)

    let order = await utils.data.getUserOrder({ DL, _user: updatedUser })

    const guestToken = cookies?.[GUEST_CART_TOKEN_COOKIE]
    if (guestToken) {
        const guestCart = await DL.GuestCart.readOne({ id: guestToken, active: true })
        if (guestCart) {
            if (!order.cart?.length && guestCart.cart?.length) {
                const transfer = {
                    domainId: guestCart.domainId,
                    cart: guestCart.cart,
                    sales: guestCart.sales,
                    sum: guestCart.sum,
                    sumNoCoupon: guestCart.sumNoCoupon,
                    finalSum: guestCart.finalSum,
                    finalSumNoCoupon: guestCart.finalSumNoCoupon,
                    coupons: guestCart.coupons
                }
                const setData = Object.fromEntries(Object.entries(transfer).filter(([, v]) => v !== undefined))
                await DL.Order.updateOne({ id: order.id }, { $set: setData })
            }
            await DL.GuestCart.deleteOne({ id: guestToken })
        }
        clearCookie(GUEST_CART_TOKEN_COOKIE)
    }

    return {
        user: updatedUser,
        order: await utils.data.getUserOrder({ DL, _user: updatedUser })
    }
}

login.config = {
    auth: 'none',
    required: ['phone', 'otpToken', 'otp']
}
