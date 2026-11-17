import cron from 'node-cron'
import log from '#server/utils/log.js'
import { acquireLock } from '#server/utils/cronLock.js'
import { retryInvoice } from '#server/utils/data/invoice.js'

const LOCK_KEY = 'invoice-retry:lock'
const LOCK_TTL_SECONDS = 15 * 60
// After this many failed attempts the document is left for manual handling
// (payment/invoice_issue) instead of retrying forever.
export const MAX_ATTEMPTS = 10

const systemActor = { role: 'system' }

async function loadFailedInvoices(DL) {
    try {
        return await DL.Invoice.read(
            {
                status: { $in: ['failed', 'pending_customer_details'] },
                attempts: { $lt: MAX_ATTEMPTS }
            },
            { _id: 0 },
            { limit: 25, sort: { updatedAt: 1 } }
        )
    } catch (e) {
        log.error('[InvoiceRetry] scan failed:', e?.message || e)
        return []
    }
}

export async function runInvoiceRetry({ DL, external, utils }) {
    let release
    try {
        release = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS)
        if (!release) {
            log.warn('[InvoiceRetry] Skipped — another instance holds the lock')
            return
        }
        const invoices = await loadFailedInvoices(DL)
        if (invoices.length === 0) return
        log.warn(`[InvoiceRetry] Started (${invoices.length} documents)`)

        for (const invoice of invoices) {
            try {
                const order = await DL.Order.readById(invoice.orderId).catch(() => null)
                if (!order || !order.paid) continue
                await DL.Invoice.updateOne(
                    { id: invoice.id },
                    { $inc: { attempts: 1 }, lastAttemptAt: new Date() }
                ).catch(() => { })
                const result = await retryInvoice({
                    DL, external, utils, order, record: invoice,
                    actor: systemActor, source: 'cron/invoice-retry'
                })
                if (result?.status === 'issued')
                    log.success(`[InvoiceRetry] ${invoice.kind} ${invoice.orderNumber}: issued ${result.docNumber}`)
                else
                    log.warn(`[InvoiceRetry] ${invoice.kind} ${invoice.orderNumber}: ${result?.error || result?.skipped || 'still failing'}`)
            } catch (e) {
                log.error(`[InvoiceRetry] invoice ${invoice.id} failed:`, e?.message || e)
            }
        }
        log.success('[InvoiceRetry] Done')
    } catch (e) {
        log.error('[InvoiceRetry] Failed:', e?.message || e)
    } finally {
        await release?.().catch(() => { })
    }
}

export default function startInvoiceRetry(bootData) {
    const schedule = process.env.INVOICE_RETRY_CRON || '*/10 * * * *'
    cron.schedule(schedule, () => runInvoiceRetry(bootData), { timezone: process.env.TZ || 'Asia/Jerusalem' })
    log.info(`[InvoiceRetry] Scheduled: ${schedule}`)
}
