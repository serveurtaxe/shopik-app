import cron from 'node-cron'
import log from '#server/utils/log.js'
import { acquireLock } from '#server/utils/cronLock.js'
import { round2 } from '#common/functions/calcOrder/utils.js'
import { planRefundLegs, executeRefundPlan } from '#server/utils/data/refundCaptures.js'
import { remainderRefundItems } from '#common/functions/refundCalc.js'

const LOCK_KEY = 'refund-retry:lock'
const LOCK_TTL_SECONDS = 30 * 60
// After this many failed auto-tries the order is left for manual handling
// (payment/refund { manual: true }) instead of retrying forever.
// Exported: order/details derives the manual-required UI gate from it.
export const MAX_ATTEMPTS = 10

const systemActor = { role: 'system' }

async function loadPendingOrders(DL) {
    try {
        return await DL.Order.Model.find({ refundPending: { $gt: 0 } }).lean()
    } catch (e) {
        log.error('[RefundRetry] scan failed:', e?.message || e)
        return []
    }
}

// One attempt for one canceled order: re-credit the pending remainder across
// the capture legs. Never throws — outcomes are recorded on the timeline.
async function retryOrder({ DL, external, utils, order }) {
    const { record } = utils.data.timeline
    const fresh = await DL.Order.readById(order.id).catch(() => null)
    if (!fresh) return
    if (fresh.status !== DL.Order.constants.ORDER_STATUS.CANCELED) return
    const pending = round2(Number(fresh.refundPending || 0))
    if (!(pending > 0.001)) {
        await DL.Order.Model.updateOne({ id: fresh.id }, { refundPending: 0 }).catch(() => { })
        return
    }
    const attempts = Number(fresh.refundPendingAttempts || 0)
    if (attempts >= MAX_ATTEMPTS) return

    const ctx = (extra = {}) => ({
        step: 'refund', provider: 'hyp', amount: pending, attempt: attempts + 1, ...extra
    })

    const { plan } = await planRefundLegs(DL, fresh, pending)
    if (!plan || plan.length === 0) {
        await DL.Order.Model.updateOne({ id: fresh.id }, { $inc: { refundPendingAttempts: 1 } }).catch(() => { })
        await record({
            DL, order: fresh,
            eventType: DL.Timeline.constants.EVENT_TYPES.REFUND,
            actor: systemActor,
            context: { ...ctx({ step: 'refund_failed' }), note: 'legs cannot cover pending' },
            outcome: { success: false, errorMessage: 'Captured legs cannot cover pending amount' },
            metadata: { source: 'cron/refund-retry' }
        }).catch(() => { })
        return
    }

    const { completed, failed } = await executeRefundPlan({
        DL, external, order: fresh, plan,
        reason: 'auto_refund_retry', items: remainderRefundItems(fresh), source: 'cron/refund-retry'
    })
    const covered = round2(completed.reduce((acc, c) => acc + Number(c.amount || 0), 0))
    const prevRefunded = Number(fresh.refundedTotal || 0)
    if (covered > 0) {
        await DL.Order.Model.updateOne({ id: fresh.id }, { $inc: { refundedTotal: covered } }).catch(() => { })
        await DL.Order.Model.updateOne({ id: fresh.id }, { finalSumAfterRefunds: round2(Number(fresh.finalSumWithShipping ?? 0) - (prevRefunded + covered)) }).catch(() => { })
    }

    if (!failed) {
        await DL.Order.Model.updateOne({ id: fresh.id }, { refundPending: 0, refundPendingAttempts: 0 }).catch(() => { })
        await record({
            DL, order: fresh,
            eventType: DL.Timeline.constants.EVENT_TYPES.REFUND,
            actor: systemActor,
            context: { ...ctx(), refunds: completed, items: remainderRefundItems(fresh) },
            changes: { oldData: { refundedTotal: prevRefunded, refundPending: pending }, newData: { refundedTotal: round2(prevRefunded + covered), refundPending: 0 } },
            outcome: { success: true },
            metadata: { source: 'cron/refund-retry', referenceOrderNumber: fresh.number }
        }).catch(() => { })
        log.success(`[RefundRetry] order ${fresh.number}: auto-refunded ${covered}`)
        return
    }

    const left = round2(pending - covered)
    const exhausted = attempts + 1 >= MAX_ATTEMPTS
    await DL.Order.Model.updateOne({ id: fresh.id }, { refundPending: left }).catch(() => { })
    await DL.Order.Model.updateOne({ id: fresh.id }, { $inc: { refundPendingAttempts: 1 } }).catch(() => { })
    await record({
        DL, order: fresh,
        eventType: DL.Timeline.constants.EVENT_TYPES.REFUND,
        actor: systemActor,
        context: {
            ...ctx({ step: 'refund_failed' }), coveredTotal: covered, pendingRefund: left,
            refunds: completed, failedLeg: { providerTxnId: failed.providerTxnId, amount: failed.amount, providerData: failed.hypRes },
            ...(exhausted ? { note: 'auto-retry exhausted, manual handling required' } : {})
        },
        outcome: { success: false, errorMessage: failed.message },
        metadata: { source: 'cron/refund-retry' }
    }).catch(() => { })
    log.warn(`[RefundRetry] order ${fresh.number}: ${failed.message} (covered ${covered}, left ${left})`)
}

export async function runRefundRetry({ DL, external, utils }) {
    let release
    try {
        release = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS)
        if (!release) {
            log.warn('[RefundRetry] Skipped — another instance holds the lock')
            return
        }
        const orders = await loadPendingOrders(DL)
        if (orders.length === 0) return
        log.warn(`[RefundRetry] Started (${orders.length} orders)`)
        for (const order of orders) {
            try {
                await retryOrder({ DL, external, utils, order })
            } catch (e) {
                log.error(`[RefundRetry] order ${order.number || order.id} failed:`, e?.message || e)
            }
        }
        log.success('[RefundRetry] Done')
    } catch (e) {
        log.error('[RefundRetry] Failed:', e?.message || e)
    } finally {
        await release?.().catch(() => { })
    }
}

export default function startRefundRetry(bootData) {
    const schedule = process.env.REFUND_RETRY_CRON || '0 */6 * * *'
    cron.schedule(schedule, () => runRefundRetry(bootData), { timezone: process.env.TZ || 'Asia/Jerusalem' })
    log.info(`[RefundRetry] Scheduled: ${schedule}`)
}
