import cron from 'node-cron'
import log from '#server/utils/log.js'
import { acquireLock } from '#server/utils/redisLock.js'
import importComaxSales from '#server/api/comax_sale/import.js'
import syncComaxSales from '#server/api/comax_sale/sync.js'

const LOCK_KEY = 'sales-sync:lock'
const LOCK_TTL_SECONDS = 60 * 60 * 2

// 1. Import promotions from Comax into the ComaxSale staging collection.
// 2. Sync staged rows into the Sale collection (upsert new/changed sales).
// 3. Roll statuses (pending -> active when started, active/pending -> done
//    when ended) and refresh product saleIds — handled inside syncComaxSales.
export async function runSalesSync(
    { DL, external },
    { importFn = importComaxSales, syncFn = syncComaxSales } = {}
) {
    let release
    try {
        release = await acquireLock(DL.redis, LOCK_KEY, LOCK_TTL_SECONDS)
        if (!release) {
            log.warn('[SalesSync] Skipped — another instance holds the lock')
            return
        }

        log.warn('[SalesSync] Started')
        const importResult = await importFn({ justActive: true, futurePromotions: true }, { DL, external })
        log.warn(`[SalesSync] Imported: ${importResult?.count ?? 0}`)
        // syncFn writes ComaxSale rows into Sale, then rolls statuses and
        // refreshes product saleIds (see sale/sync.js).
        const syncResult = await syncFn({ justActive: true, futurePromotions: true }, { DL })
        const statusUpdates = syncResult?.saleUpdates ?? syncResult ?? {}
        log.success(`[SalesSync] Done: imported=${importResult?.count ?? 0}, sales=${syncResult?.synced ?? 0} (created=${syncResult?.created ?? 0}, updated=${syncResult?.updated ?? 0}), statuses=${JSON.stringify({ done: statusUpdates?.updatedToDone, active: statusUpdates?.updatedToActive })}, products=${statusUpdates?.updatedProducts ?? 0}, cleared=${statusUpdates?.clearedProducts ?? 0}`)
        return { importResult, syncResult }
    } catch (e) {
        log.error('[SalesSync] Failed:', e?.message || e)
        throw e
    } finally {
        await release?.().catch(() => { })
    }
}

export default function startSalesSync(bootData) {
    const schedule = process.env.SALES_SYNC_CRON || '30 3 * * *'
    cron.schedule(schedule, () => runSalesSync(bootData), { timezone: process.env.TZ || 'Asia/Jerusalem' })
    log.info(`[SalesSync] Scheduled: ${schedule}`)
}
