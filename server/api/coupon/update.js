import diff from '#common/functions/diff.js'
import purgeCouponFromCarts from '#server/utils/data/purgeCouponFromCarts.js'

export default async function update(payload, { DL, _admin, utils }) {
    const { id } = payload

    const coupon = await DL.Coupon.readById(id)
    if (!coupon) throw { status: 400, message: 'coupon does not exist' }

    const update = diff(coupon, payload)
    const nothingToUpdate = Object.keys(update).length === 0
    if (nothingToUpdate) return coupon

    const updated = await DL.Coupon.updateOne({ id }, update)

    // A newly blacklisted customer may still hold the coupon in an open cart.
    // Drop it there too so the discount cannot survive to payment.
    if (Array.isArray(update.blacklist)) {
        const existing = new Set((coupon.blacklist || []).map(String))
        const newlyBlacklisted = update.blacklist.filter(userId => !existing.has(String(userId)))
        if (newlyBlacklisted.length) {
            try {
                await purgeCouponFromCarts({
                    DL,
                    utils,
                    code: coupon.code,
                    userIds: newlyBlacklisted
                })
            } catch { }
        }
    }

    return updated
}

update.config = {
    required: ['id'],
    permissions: ['coupon:update']
}
