import pLimit from 'p-limit'
import { enqueueFetchJobs, getFetchQueue, getProcessQueue } from '#server/queues/gs1Queues.js'
import { flush } from './bulk.js'
import log from '#server/utils/log.js'
import formatISODate from '#common/functions/formatISODate.js'

const RELEVANT_TYPES = new Set(['New_Publish', 'Update_Product'])
const OVERLAP_MS = 2 * 60 * 60 * 1000

const fmtDate = formatISODate

function monthChunks(from, to, monthsPerChunk = 1) {
    const chunks = []
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1)
    while (cursor <= to) {
        const end = new Date(cursor.getFullYear(), cursor.getMonth() + monthsPerChunk, 0)
        chunks.push([new Date(cursor), end > to ? new Date(to) : end])
        cursor.setMonth(cursor.getMonth() + monthsPerChunk)
    }
    return chunks
}

// Page the message queue in month chunks (wide ranges 500 on the GS1 side —
// scale with more concurrent SMALL chunks, never bigger ones).
export async function collectProductCodes(external, from, to) {
    const chunkMonths = Number(process.env.GS1_CHUNK_MONTHS || 1)
    const chunks = monthChunks(from, to, chunkMonths)
    const limit = pLimit(Number(process.env.GS1_CHUNK_CONCURRENCY || 6))
    const codes = new Set()
    await Promise.all(chunks.map(([s, e]) => limit(async () => {
        let messages
        try {
            messages = await external.gs1.getMessages(fmtDate(s), fmtDate(e))
        } catch (err) {
            if (err?.transient || err?.rateLimited) throw err
            log.warn(`[GS1] Messages chunk ${fmtDate(s)}→${fmtDate(e)} failed:`, err?.message || err)
            return
        }
        for (const m of messages || []) {
            if (RELEVANT_TYPES.has(m?.message_type) && m?.message_identifier)
                codes.add(m.message_identifier)
        }
    })))
    return [...codes]
}

export async function getWatermark(DL) {
    return DL.Gs1SyncState.readOne({ key: 'watermark' }, { _id: 0, lastSyncAt: 1 })
        .catch(() => null)
}

// Enqueue a run: bootstrap (explicit from/to) or incremental (from watermark).
// Watermark advances to run start (minus overlap) at enqueue time.
export async function startRun(payload, { DL, external }) {
    const now = new Date()
    const watermark = await getWatermark(DL)
    const from = payload.from
        ? new Date(payload.from)
        : watermark?.lastSyncAt
            ? new Date(new Date(watermark.lastSyncAt).getTime() - OVERLAP_MS)
            : new Date(process.env.GS1_BOOTSTRAP_FROM || '2017-01-01')
    const to = payload.to ? new Date(payload.to) : now

    const runId = `run:${now.getTime()}`
    await DL.Gs1SyncState.updateOne(
        { key: runId },
        { $set: { status: 'collecting', total: 0, processed: 0, failed: 0, startedAt: now } },
        { upsert: true }
    )

    log.warn(`[GS1] Collecting messages ${fmtDate(from)}→${fmtDate(to)}`)
    const codes = await collectProductCodes(external, from, to)
    await DL.Gs1SyncState.updateOne(
        { key: runId },
        { $set: { status: 'running', total: codes.length } }
    )
    const { enqueued } = await enqueueFetchJobs(codes.map(productCode => ({
        productCode, runId, force: payload.force ?? false
    })))

    await DL.Gs1SyncState.updateOne(
        { key: 'watermark' },
        { $set: { lastSyncAt: new Date(now.getTime() - OVERLAP_MS) } },
        { upsert: true }
    )

    log.success(`[GS1] Run ${runId}: ${enqueued} products queued`)
    return { runId, total: codes.length, enqueued, from: fmtDate(from), to: fmtDate(to) }
}

export async function finalizeRun(runId, { DL }) {
    if (!runId) return null
    const state = await DL.Gs1SyncState.readOne({ key: runId }, { _id: 0 }).catch(() => null)
    if (!state || state.status === 'done' || state.status === 'completed') return state
    // Only 'running' runs can complete — 'collecting' hasn't set total yet.
    if (state.status !== 'running') return state
    // Flush buffered $inc progress so counters are fresh before deciding.
    try { await flush() } catch { }
    const fresh = await DL.Gs1SyncState.readOne({ key: runId }, { _id: 0 }).catch(() => state)
    const [fetch, process] = await Promise.all([
        getFetchQueue().getJobCounts('waiting', 'active', 'delayed').catch(() => ({})),
        getProcessQueue().getJobCounts('waiting', 'active', 'delayed').catch(() => ({}))
    ])
    const pending = (fetch.waiting || 0) + (fetch.active || 0) + (fetch.delayed || 0)
        + (process.waiting || 0) + (process.active || 0) + (process.delayed || 0)
    // Failed BullMQ jobs are terminal (no retry pending) — they must not block completion.
    if (pending !== 0) return fresh
    // Queues drained: no more progress will arrive. Mark done even if
    // processed < total (crash-loss window) so the run can't stick in 'running'.
    const finishedAt = new Date()
    await DL.Gs1SyncState.updateOne(
        { key: runId },
        { $set: { status: 'done', finishedAt } }
    ).catch(() => { })
    return { ...fresh, status: 'done', finishedAt }
}

export async function getStatus(runId, { DL }) {
    let state = runId
        ? await DL.Gs1SyncState.readOne({ key: runId }, { _id: 0 }).catch(() => null)
        : null
    // Lazy self-heal: runs stuck in 'running' after queues drained
    // transition to 'done' on next status poll (no manual DB fix needed).
    if (state?.status === 'running')
        state = await finalizeRun(runId, { DL }).catch(() => state) || state
    const [fetch, process] = await Promise.all([
        getFetchQueue().getJobCounts('waiting', 'active', 'delayed', 'failed').catch(() => ({})),
        getProcessQueue().getJobCounts('waiting', 'active', 'delayed', 'failed').catch(() => ({}))
    ])
    return { state, queues: { fetch, process } }
}

export default { collectProductCodes, getWatermark, startRun, finalizeRun, getStatus }
