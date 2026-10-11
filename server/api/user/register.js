import uid from '#common/functions/uid.js'

export default async function register(payload, { DL, utils, external }) {
    const name = utils.extractFields.getName(payload)
    if (name) payload.name = name

    const allowed = ['phone', 'name', 'email', 'getOffers', 'domainId']
    const domainId = payload.domainId
    const remember = payload.remember === true
    const filtered = {}
    for (const key of allowed) {
        if (payload[key] !== undefined) filtered[key] = payload[key]
    }

    const existingPhone = await DL.User.count({ phone: filtered.phone })
    // Generic message: do not reveal whether the number is registered.
    if (existingPhone)
        throw { status: 409, message: 'Could not start registration for this number' }

    const currentOtps = await DL.Otp.count({ phone: filtered.phone })
    if (currentOtps >= 5) throw { status: 400, message: 'too many otps' }

    // Per-phone hourly cap (SMS-flood protection, IP-independent).
    // Fail-open when redis is unavailable.
    if (DL.redis) {
        try {
            const sendKey = `otp_send:${filtered.phone}`
            const sent = await DL.redis.incr(sendKey)
            if (sent === 1) await DL.redis.expire(sendKey, 3600)
            if (sent > 10) throw { status: 400, message: 'too many otps' }
        } catch (e) {
            if (e?.status === 400) throw e
        }
    }

    const token = uid()
    const otp = uid(6, true)
    await DL.Otp.create({
        phone: filtered.phone,
        token,
        otp,
        remember,
        payload: filtered
    })
    await external.sms.otp(filtered.phone, otp, { domainId })

    return { user: filtered, token }
}

register.config = { auth: 'none', required: ['phone'] }
