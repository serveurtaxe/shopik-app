import { BOT_TOKEN_EXPIRY_MS } from '#common/constants.js'
import { redisDel } from '#server/utils/redisSafe.js'

/**
 * POST /api/bot/otp_verify
 * Auth: API key with `bot:otp` permission (router enforces).
 * Body: { phone, otpToken, otp }
 * Verifies the OTP issued by bot/otp_request and returns a userToken
 * the bot must send on every subsequent bot/* call (per dev spec),
 * plus the customer's first name so the bot can address them.
 * Returns: { userToken, firstName }
 */
export default async function otp_verify(payload, { DL, utils }) {
    const { phone, otpToken, otp, domainId } = payload || {}
    if (!phone || !otpToken || !otp) throw { status: 400, message: 'phone, otpToken and otp required' }

    const storedOtp = await DL.Otp.readOne({ token: otpToken })
    if (!storedOtp || storedOtp.otp !== otp || String(storedOtp.phone) !== String(phone)) {
        if (storedOtp?._id) {
            const attempts = (storedOtp.attempts || 0) + 1
            if (attempts >= 5) {
                try { await DL.Otp.deleteOne({ _id: storedOtp._id }) } catch { }
                throw { message: 'Too many failed attempts. Code expired.', status: 403 }
            }
            try { await DL.Otp.updateOne({ _id: storedOtp._id }, { attempts }) } catch { }
        }
        throw { message: 'invalid OTP', status: 403 }
    }

    const userFilter = domainId ? { domainId, phone } : { phone }
    const user = await DL.User.readOne(userFilter)
    if (!user) throw { message: 'login failed', status: 403 }

    const userToken = utils.auth.createToken(user.id, BOT_TOKEN_EXPIRY_MS)
    await DL.User.updateOne(
        { id: user.id },
        { lastLogin: new Date(), [`tokens.bot`]: userToken }
    )
    try { await redisDel(DL.redis, `user_auth:${user.id}`) } catch { }
    try { await DL.Otp.deleteOne({ _id: storedOtp._id }) } catch { }

    return { userToken, firstName: user.name?.first || null }
}

otp_verify.config = {
    auth: 'none',
    required: ['phone', 'otpToken', 'otp'],
    permissions: ['bot:otp']
}
