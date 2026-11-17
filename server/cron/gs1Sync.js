import cron from 'node-cron'
import log from '#server/utils/log.js'
import { acquireLock } from '#server/utils/cronLock.js'
import { startRun, finalizeRun } from '#server/services/gs1/sync.js'
import { runEnrich, runImages } from '#server/services/gs1/enrich.js'
import { getFetchQueue } from '#server/queues/gs1Queues.js'
import { initBulkFlusher, flush } from '#server/services/gs1/bulk.js'
import { trimMemory } from '#server/utils/mem.js'

const LOCK_KEY = 'gs1-sync:lock'
const LOCK_TTL_SECONDS = 60 * 60 * 6

async function waitFetchDrain(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    for (;;) {
        const counts = await getFetchQueue()
            .getJobCounts('waiting', 'active', 'delayed').catch(() => ({}))
        const pending = (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0)
        if (!pending) return
        if (Date.now() > deadline) throw new Error(`fetch queue did not drain (${pending} left)`)
        await new Promise(r => setTimeout(r, 15000))
    }
}

// Nightly three-phase GS1 run: fetch dump → enrich texts → launch images.
// Runs after the Comax sync so the Comax-existence gate is fresh.
// Exported so the job can be run (and measured) outside the scheduler.
export async function runGs1Sync({ DL, external }) {
    let release
    try {
        release = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS)
        if (!release) {
            log.warn('[Gs1Sync] Skipped — another instance holds the lock')
            return null
        }
        initBulkFlusher(DL)
        log.warn('[Gs1Sync] Phase 1: fetch dump started')
        const run = await startRun({}, { DL, external })
        await waitFetchDrain(Number(process.env.GS1_DRAIN_TIMEOUT_MS || 6 * 60 * 60 * 1000))
        log.warn('[Gs1Sync] Phase 2: enrich texts started')
        const texts = await runEnrich({ DL, external, runId: run.runId, onlyInStock: true })
        trimMemory('after enrich', 'Gs1Sync')
        log.warn('[Gs1Sync] Phase 3: images launch started')
        const images = await runImages({ DL, external, runId: run.runId })
        trimMemory('after images', 'Gs1Sync')
        log.success(`[Gs1Sync] Done: run=${run.runId} fetched=${run.total} `
            + `enriched=${texts.enriched} skipped=${texts.skipped} imagesQueued=${images.queued}`)
        await flush().catch(() => { })
        await finalizeRun(run.runId, { DL }).catch(() => { })
        return { run, texts, images }
    } catch (e) {
        log.error('[Gs1Sync] Failed:', e?.message || e)
        return null
    } finally {
        await release?.().catch(() => { })
    }
}

export default function startGs1Sync(bootData) {
    const { DL, external } = bootData
    if (process.env.GS1_SYNC_ENABLED === 'false') {
        log.info('[Gs1Sync] Disabled via GS1_SYNC_ENABLED=false')
        return
    }
    const schedule = process.env.GS1_SYNC_CRON || '0 4 * * *'

    cron.schedule(schedule, () => runGs1Sync({ DL, external }),
        { timezone: process.env.TZ || 'Asia/Jerusalem' })

    log.info(`[Gs1Sync] Scheduled: ${schedule}`)
}
