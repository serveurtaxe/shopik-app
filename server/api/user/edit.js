import diff from '#common/functions/diff.js'
import uid from '#common/functions/uid.js'
import { redisDel } from '#server/utils/redisSafe.js'

export default async function edit(payload, { DL, _user, external, utils }) {
    const name = utils.extractFields.getName(payload)
    if (name) payload.name = name

    // Allowlist: ignore any client-supplied internal fields (blocked,
    // noMinOrderSum, domainId, isTestUser, comments, ...). Phone flows
    // through OTP verification below (never written directly).
    const ALLOWED_USER_FIELDS = ['name', 'email', 'phone', 'secondPhone', 'getOffers', 'replaceProducts', 'notAtHome', 'taxId', 'companyName']
    const sanitizedPayload = {}
    for (const key of ALLOWED_USER_FIELDS) {
        if (payload[key] !== undefined) sanitizedPayload[key] = payload[key]
    }

    const update = diff(_user, sanitizedPayload)

    const nothingToUpdate = Object.keys(update).length === 0
    if (nothingToUpdate) return { user: _user }

    let phoneChanged = false,
        token
    if (update.phone) {
        const currentOtps = await DL.Otp.count({ phone: update.phone })
        if (currentOtps >= 5) throw { status: 400, message: 'too many otps' }
        // Per-phone hourly cap (SMS-flood protection, IP-independent).
        // Fail-open when redis is unavailable.
        if (DL.redis) {
            try {
                const sendKey = `otp_send:${update.phone}`
                const sent = await DL.redis.incr(sendKey)
                if (sent === 1) await DL.redis.expire(sendKey, 3600)
                if (sent > 10) throw { status: 400, message: 'too many otps' }
            } catch (e) {
                if (e?.status === 400) throw e
            }
        }
        phoneChanged = true
        token = uid()
        const otp = uid(6, true)
        await DL.Otp.create({
            phone: update.phone,
            token,
            otp,
            userId: _user.id
        })
        await external.sms.otp(update.phone, otp, { domainId: payload.domainId, voice: true })
        delete update.phone
    }

    let savedUser
    if (Object.keys(update).length > 0)
        savedUser = await DL.User.updateOne({ id: _user.id }, update, { select: DL.User.defaultSelect })

    if (!savedUser)
        savedUser = _user

    await redisDel(DL.redis, `user_auth:${_user.id}`)

    if (phoneChanged)
        return { user: savedUser, phone: payload.phone, token }

    return { user: savedUser }
}

edit.config = { auth: 'required' }
