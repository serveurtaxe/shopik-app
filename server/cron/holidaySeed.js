import cron from 'node-cron'
import { HebrewCalendar, flags } from '@hebcal/core'
import log from '#server/utils/log.js'
import { acquireLock } from '#server/utils/cronLock.js'
import { trimMemory } from '#server/utils/mem.js'
import { SPECIAL_DAY_EREV_START } from '#common/constants.js'
import { overlapsSpecialDay } from '#common/functions/specialDay.js'
import uid from '#common/functions/uid.js'

// Yamim Tovim observed in Israel (CHAG flag): Rosh Hashana x2, Yom Kippur,
// Sukkot I, Shmini Atzeret/Simchat Torah, Pesach I + VII, Shavuot.
// Chol HaMoed, Purim, fasts, memorial/modern days don't carry the CHAG flag.
// Erev Yom Tov events (candle-lighting erevs) become half-day closures.
export async function seedHolidays(DL) {
    const monthsAhead = Number(process.env.HOLIDAY_SEED_MONTHS_AHEAD) || 12
    const now = new Date()
    const end = new Date(now)
    end.setMonth(end.getMonth() + monthsAhead)

    const formatInIL = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jerusalem',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    })
    const todayStr = formatInIL.format(now)
    const endStr = formatInIL.format(end)

    const candidates = []
    for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
        const events = HebrewCalendar.calendar({ year, il: true })
        for (const ev of events) {
            const date = formatInIL.format(ev.getDate().greg())
            if (date < todayStr || date > endStr) continue

            const f = ev.getFlags()
            const name = ev.render('he') || ev.getDesc()
            const base = { name, date, storeIds: [], source: 'hebcal' }

            if (f & flags.CHAG) {
                candidates.push({ ...base, start: null, end: null })
            } else if ((f & flags.EREV) && (f & flags.LIGHT_CANDLES) && !(f & flags.MAJOR_FAST)) {
                candidates.push({ ...base, start: SPECIAL_DAY_EREV_START, end: 23 })
            }
        }
    }

    const dates = [...new Set(candidates.map(c => c.date))]
    const allSameDates = dates.length
        ? await DL.SpecialDay.Model.find({ active: true, date: { $in: dates } })
            .select({ _id: 0, date: 1, storeIds: 1, start: 1, end: 1 })
            .lean()
        : []
    const byDate = new Map()
    for (const doc of allSameDates) {
        if (!byDate.has(doc.date)) byDate.set(doc.date, [])
        byDate.get(doc.date).push(doc)
    }

    const toInsert = []
    for (const candidate of candidates) {
        // Idempotent: skip when any active all-store closure already overlaps
        // this range — including admin-created replacements (never overwritten).
        const sameDate = byDate.get(candidate.date) || []
        const globalSameDate = sameDate.filter(sd => !sd.storeIds?.length)

        if (globalSameDate.some(existing => overlapsSpecialDay(candidate, existing)))
            continue

        toInsert.push({ id: uid(), ...candidate })
    }

    if (toInsert.length) await DL.SpecialDay.bulkWrite({ docs: toInsert })

    return { seeded: toInsert.length, total: candidates.length }
}

const LOCK_KEY = 'holiday-seed:lock'
const LOCK_TTL_SECONDS = 60 * 10

export default function startHolidaySeed(bootData) {
    const { DL } = bootData
    const schedule = process.env.HOLIDAY_SEED_CRON || '0 3 * * 1'

    cron.schedule(schedule, async () => {
        let release
        try {
            release = await acquireLock(LOCK_KEY, LOCK_TTL_SECONDS)
            if (!release) {
                log.warn('[HolidaySeed] Skipped — another instance holds the lock')
                return
            }

            const result = await seedHolidays(DL)
            trimMemory('after holiday seed', 'HolidaySeed')
            log.success(`[HolidaySeed] Done: ${result.seeded} seeded of ${result.total} candidates`)
        } catch (e) {
            log.error('[HolidaySeed] Failed:', e?.message || e)
        } finally {
            await release?.().catch(() => { })
        }
    }, { timezone: process.env.TZ || 'Asia/Jerusalem' })

    log.info(`[HolidaySeed] Scheduled: ${schedule}`)
}
