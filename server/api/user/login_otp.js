import uid from '#common/functions/uid.js'
import toRemember from '#common/functions/toRemember.js'

export default async function login_otp({ phone, remember, domainId }, { DL, external }) {
    const user = await DL.User.readOne({ phone }, { phone: 1 })
    // Generic message: do not reveal whether the number is registered.
    if (!user) throw { status: 400, message: 'Could not send a verification code to this number' }
    const currentOtps = await DL.Otp.count({ phone })
    if (currentOtps >= 5) throw { status: 400, message: 'too many otps' }

    // Per-phone hourly cap (SMS-flood protection, IP-independent).
    // Fail-open when redis is unavailable.
    if (DL.redis) {
        try {
            const sendKey = `otp_send:${phone}`
            const sent = await DL.redis.incr(sendKey)
            if (sent === 1) await DL.redis.expire(sendKey, 3600)
            if (sent > 10) throw { status: 400, message: 'too many otps' }
        } catch (e) {
            if (e?.status === 400) throw e
        }
    }

    const token = uid()
    const otp = uid(6, true)
    await DL.Otp.create({ phone, token, otp, remember: toRemember(remember) })
    await external.sms.otp(phone, otp, { domainId })

    return { token }
}

login_otp.config = { auth: 'none', required: ['phone'] }
