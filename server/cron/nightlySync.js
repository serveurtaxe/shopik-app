import cron from 'node-cron'
import log from '#server/utils/log.js'
import { acquireLock } from '#server/utils/cronLock.js'
import importComaxProducts from '#server/api/comax_product/import.js'
import syncComax from '#server/api/comax_product/sync.js'
import enqueueChangedImages from '#server/services/image/enqueue.js'
import importGovAddresses from '#server/scripts/importGovAddresses.js'
import { trimMemory } from '#server/utils/mem.js'

const LOCK_KEY = 'nightly-sync:lock'
const LOCK_TTL_SECONDS = 60 * 60 * 4
const GOV_LOCK_KEY = 'gov-sync:lock'
// importGovAddresses pages through ~150k data.gov.il rows with a delay per page.
const GOV_LOCK_TTL_SECONDS = 60 * 60 * 2

// Import → sync → image enqueue, under the same lock the scheduler takes.
// Exported so the job can be run (and measured) outside the scheduler.
export async function runNightlySync({ DL, external }) {
    let release
    try {
        release = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS)
        if (!release) {
            log.warn('[NightlySync] Skipped — another instance holds the lock')
            return null
        }

        log.warn('[NightlySync] Started')
        // The store feed carries the delivery price row (SalesPriceArray),
        // so a separate buying-price import is no longer needed.
        const importResult = await importComaxProducts({}, { DL, external })
        trimMemory('after product import', 'NightlySync')
        // sync skips its internal image enqueue — nightly runs it once below.
        const syncResult = await syncComax({ skipImageEnqueue: true }, { DL })
        trimMemory('after product sync', 'NightlySync')
        const enqueueResult = await enqueueChangedImages(DL)
        trimMemory('after image enqueue', 'NightlySync')

        log.success(`[NightlySync] Done: import=${importResult.count}, sync=${syncResult.synced}, images=${enqueueResult.enqueued}`)
        return { importResult, syncResult, enqueueResult }
    } catch (e) {
        log.error('[NightlySync] Failed:', e?.message || e)
        return null
    } finally {
        await release?.().catch(() => { })
    }
}

export async function runGovAddressSync({ DL }) {
    let release
    try {
        release = await acquireLock(GOV_LOCK_KEY, GOV_LOCK_TTL_SECONDS)
        if (!release) return null
        log.warn('[GovSync] Started')
        await importGovAddresses({ DL })
        trimMemory('after gov import', 'GovSync')
        log.success('[GovSync] Done')
    } catch (e) {
        log.error('[GovSync] Failed:', e?.message || e)
        return null
    } finally {
        await release?.().catch(() => { })
    }
}

export default function startNightlySync(bootData) {

    const { DL, external } = bootData
    const schedule = process.env.NIGHTLY_SYNC_CRON || '0 2 * * *'
    const govSchedule = process.env.GOV_SYNC_CRON || '0 3 * * 0' // weekly Sunday 03:00

    cron.schedule(schedule, () => runNightlySync({ DL, external }),
        { timezone: process.env.TZ || 'Asia/Jerusalem' })

    cron.schedule(govSchedule, () => runGovAddressSync({ DL }),
        { timezone: process.env.TZ || 'Asia/Jerusalem' })

    log.info(`[NightlySync] Scheduled: ${schedule}`)
    log.info(`[GovSync] Scheduled: ${govSchedule} (gov_address) — no boot fetch, weekly only`)
}