import cron from 'node-cron'
import log from '#server/utils/log.js'
import { acquireLock } from '#server/utils/redisLock.js'
import { fetchAndStoreDeliveryDoc } from '#server/external/comax/deliverySync.js'

const LOCK_KEY = 'delivery-docs-sync:lock'
const LOCK_TTL_SECONDS = 10 * 60
const BATCH_LIMIT = Number(process.env.COMAX_DELIVERY_SYNC_BATCH || 50)

// Only rows whose backoff has elapsed (or never attempted) are due.
async function loadDueDocs(DL) {
    try {
        return await DL.ComaxDeliveryDoc.read(
            { status: 'pending', nextAttemptAt: { $lte: new Date() } },
            { _id: 0, docNumber: 1 },
            { limit: BATCH_LIMIT }
        ).catch(() =>
            DL.ComaxDeliveryDoc.read({ status: 'pending' }, { _id: 0, docNumber: 1 }, { limit: BATCH_LIMIT })
        )
    } catch (e) {
        log.error('[DeliveryDocsSync] scan failed:', e?.message || e)
        return []
    }
}

export async function runDeliveryDocsSync({ DL }) {
    let release
    try {
        release = await acquireLock(DL.redis, LOCK_KEY, LOCK_TTL_SECONDS)
        if (!release) {
            log.warn('[DeliveryDocsSync] Skipped — another instance holds the lock')
            return
        }
        const docs = await loadDueDocs(DL)
        if (docs.length === 0) return
        log.warn(`[DeliveryDocsSync] Started (${docs.length} docs)`)
        for (const doc of docs) {
            try {
                const outcome = await fetchAndStoreDeliveryDoc({ DL, docNumber: doc.docNumber })
                log.info(`[DeliveryDocsSync] doc ${doc.docNumber}: ${outcome}`)
            } catch (e) {
                log.error(`[DeliveryDocsSync] doc ${doc.docNumber} failed:`, e?.message || e)
            }
        }
        log.success('[DeliveryDocsSync] Done')
    } catch (e) {
        log.error('[DeliveryDocsSync] Failed:', e?.message || e)
    } finally {
        await release?.().catch(() => { })
    }
}

export default function startDeliveryDocsSync(bootData) {
    const schedule = process.env.COMAX_DELIVERY_SYNC_CRON || '*/5 * * * *'
    cron.schedule(schedule, () => runDeliveryDocsSync(bootData), { timezone: process.env.TZ || 'Asia/Jerusalem' })
    log.info(`[DeliveryDocsSync] Scheduled: ${schedule}`)
}
