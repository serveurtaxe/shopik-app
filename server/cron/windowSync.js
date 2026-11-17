import cron from 'node-cron'
import log from '#server/utils/log.js'
import { acquireLock } from '#server/utils/cronLock.js'
import syncWindows from '#server/api/order_window_template/sync.js'

const LOCK_KEY = 'window-sync:lock'
const LOCK_TTL_SECONDS = 60 * 60

// Weekly full sync of order windows from templates (all active stores).
// Regenerates the 30-day horizon so template edits drift into future windows.
export async function runWindowSync({ DL }) {
    let release
    try {
        release = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS)
        if (!release) {
            log.warn('[WindowSync] Skipped — another instance holds the lock')
            return
        }
        log.warn('[WindowSync] Started')
        const results = await syncWindows({}, { DL })
        const totals = (results || []).reduce((acc, s) => ({
            created: acc.created + (+s.synced?.created || 0),
            updated: acc.updated + (+s.synced?.updated || 0),
            deleted: acc.deleted + (+s.synced?.deleted || 0)
        }), { created: 0, updated: 0, deleted: 0 })
        log.success(`[WindowSync] Done: stores=${(results || []).length} `
            + `created=${totals.created} updated=${totals.updated} deleted=${totals.deleted}`)
        return results
    } catch (e) {
        log.error('[WindowSync] Failed:', e?.message || e)
    } finally {
        await release?.().catch(() => { })
    }
}

export default function startWindowSync(bootData) {
    const schedule = process.env.WINDOW_SYNC_CRON || '0 1 * * 0'

    cron.schedule(schedule, () => runWindowSync(bootData), { timezone: process.env.TZ || 'Asia/Jerusalem' })

    log.info(`[WindowSync] Scheduled: ${schedule}`)
}
