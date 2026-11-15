/**
 * Backfill: mark coupon usage from already-paid orders (one-off).
 *
 * Live code blacklists the paying customer when a coupon is used, which makes
 * every coupon single-use per customer, and cancels a `personal` coupon so no
 * one else can redeem it. Orders paid before that hook existed carry no usage
 * record, so this script replays them:
 *
 *   - every (coupon, customer) pair from a paid order joins `Coupon.blacklist`;
 *   - coupons marked `personal` (or legacy `multi: false`) are canceled;
 *   - open carts that still hold a now-unusable coupon are cleaned up.
 *
 * Paid means any status other than `cart` / `failed`. `canceled` is included on
 * purpose: the live hook blacklists at payment and does not release the
 * customer when the order is later canceled, so the backfill matches it.
 *
 * Usage: node server/scripts/runBackfillCouponUsage.js [--dry-run] [--limit N]
 */
import removeCouponFromCart from '#server/utils/data/removeCouponFromCart.js'

const PAGE_SIZE = 500
const WRITE_CHUNK = 1000
const NOT_PAID_STATUSES = ['cart', 'failed']

export function collectUsage(order, usageByCode = new Map()) {
    const userId = order?.userId
    if (!userId) return usageByCode

    for (const entry of order.coupons || []) {
        const code = String(entry?.code || '').trim().toLowerCase()
        if (!code) continue
        if (!usageByCode.has(code)) usageByCode.set(code, new Set())
        usageByCode.get(code).add(String(userId))
    }
    return usageByCode
}

export function planCouponUpdates(coupons, usageByCode) {
    const plans = []

    for (const coupon of coupons || []) {
        const code = String(coupon?.code || '').trim().toLowerCase()
        const users = usageByCode.get(code)
        if (!code || !users?.size) continue

        const known = new Set((coupon.blacklist || []).map(String))
        const add = [...users].filter(userId => !known.has(userId))

        // Legacy docs predate the personal flag and carry `multi` instead.
        const closesAfterUse = coupon.personal === true || coupon.multi === false
        const cancel = closesAfterUse && coupon.status !== 'canceled'
        if (!add.length && !cancel) continue

        plans.push({ coupon, add, cancel })
    }

    return plans
}

export function cartPurgePlan(carts, plans) {
    const byCode = new Map()

    for (const plan of plans || []) {
        byCode.set(String(plan.coupon.code).trim().toLowerCase(), {
            cancel: plan.cancel,
            // Resolve against the final list so carts already in violation from
            // an earlier partial run are cleaned too.
            blacklist: new Set([
                ...(plan.coupon.blacklist || []).map(String),
                ...plan.add.map(String)
            ])
        })
    }

    const targets = []
    for (const cart of carts || []) {
        for (const entry of cart.coupons || []) {
            const code = String(entry?.code || '').trim().toLowerCase()
            const plan = byCode.get(code)
            if (!plan) continue
            if (plan.cancel || plan.blacklist.has(String(cart.userId))) {
                targets.push({ cart, code })
                // removeCouponFromCart clears the cart's coupons array.
                break
            }
        }
    }
    return targets
}

export default async function backfillCouponUsage(
    { DL, utils } = {},
    { dryRun = false, limit = 0 } = {}
) {
    if (!DL?.Coupon || !DL?.Order?.Model) throw new Error('DL required')

    const cap = Number(limit) || 0
    const coupons = await DL.Coupon.read({}, { _id: 0 }, { limit: 0 })
    const usageByCode = new Map()

    const totals = {
        ordersScanned: 0,
        usagePairs: 0,
        couponsMatched: 0,
        usersAdded: 0,
        canceled: 0,
        cartsToPurge: 0,
        cartsPurged: 0,
        unknownCodes: 0
    }

    console.log(`[backfillCouponUsage] scanning paid orders${dryRun ? ' (DRY RUN — no writes)' : ''}`)

    let lastId = null
    for (; ;) {
        const filter = {
            status: { $nin: NOT_PAID_STATUSES },
            'coupons.0': { $exists: true },
            userId: { $exists: true, $ne: null }
        }
        if (lastId) filter._id = { $gt: lastId }

        const orders = await DL.Order.Model.find(
            filter,
            { _id: 1, userId: 1, coupons: 1 }
        ).sort({ _id: 1 }).limit(PAGE_SIZE).lean()
        if (!orders?.length) break

        for (const order of orders) {
            if (cap && totals.ordersScanned >= cap) break
            totals.ordersScanned++
            collectUsage(order, usageByCode)
        }

        lastId = orders[orders.length - 1]._id
        if (cap && totals.ordersScanned >= cap) break
        if (totals.ordersScanned % 5000 < PAGE_SIZE)
            console.log(`[backfillCouponUsage] ${totals.ordersScanned} orders scanned...`)
    }

    totals.usagePairs = [...usageByCode.values()].reduce((sum, users) => sum + users.size, 0)

    const couponCodes = new Set(coupons.map(c => String(c.code).trim().toLowerCase()))
    totals.unknownCodes = [...usageByCode.keys()].filter(code => !couponCodes.has(code)).length

    const plans = planCouponUpdates(coupons, usageByCode)
    totals.couponsMatched = plans.length

    for (const plan of plans) {
        totals.usersAdded += plan.add.length
        if (plan.cancel) totals.canceled++
        console.log(
            `[backfillCouponUsage] ${plan.coupon.code}: +${plan.add.length} blacklist` +
            (plan.cancel ? ', cancel' : '')
        )
        if (dryRun) continue

        for (let i = 0; i < plan.add.length; i += WRITE_CHUNK) {
            const chunk = plan.add.slice(i, i + WRITE_CHUNK)
            await DL.Coupon.updateOne(
                { id: plan.coupon.id },
                { $addToSet: { blacklist: { $each: chunk } } }
            )
        }
        if (plan.cancel) {
            await DL.Coupon.updateOne(
                { id: plan.coupon.id },
                { $set: { status: 'canceled' } }
            )
        }
    }

    const carts = plans.length
        ? await DL.Order.Model.find(
            { status: 'cart', active: true, 'coupons.0': { $exists: true } },
            { _id: 0, id: 1, userId: 1, coupons: 1, sum: 1, sumNoCoupon: 1, shipping: 1 }
        ).lean()
        : []

    const targets = cartPurgePlan(carts || [], plans)
    totals.cartsToPurge = targets.length

    if (!dryRun) {
        for (const { cart, code } of targets) {
            try {
                const updated = await removeCouponFromCart({ DL, utils, order: cart, code, actor: null })
                if (updated) totals.cartsPurged++
            } catch (e) {
                console.log(`[backfillCouponUsage] cart ${cart.id} cleanup failed: ${e?.message || e}`)
            }
        }
    }

    console.log(
        `[backfillCouponUsage] done: orders=${totals.ordersScanned} usagePairs=${totals.usagePairs} ` +
        `coupons=${totals.couponsMatched} usersAdded=${totals.usersAdded} canceled=${totals.canceled} ` +
        `cartsToPurge=${totals.cartsToPurge} cartsPurged=${dryRun ? 0 : totals.cartsPurged} ` +
        `unknownCodes=${totals.unknownCodes}`
    )

    return totals
}
