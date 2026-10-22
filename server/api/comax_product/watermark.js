export const PRODUCTS = 'products'
export const BUYING_PRICES = 'buyingPrices'

/**
 * The date the next import should start from.
 *
 * The watermark lives in comax_sync_state and advances ONLY after a fully
 * successful run. It used to be derived from max(lastImportedAt) across the
 * product docs: when a batch failed, those products kept an older timestamp
 * while the successful ones got the new one — and the MAX picked the new
 * one, so the failed products were never fetched again. Permanent loss.
 */
export async function getWatermark(DL, key) {
    const state = await DL.ComaxSyncState.readOne({ key }, { _id: 0, lastSyncAt: 1 })
    if (state?.lastSyncAt) return new Date(state.lastSyncAt)
    return null
}

/**
 * First run after the switch: there is no state doc yet. Fall back to the
 * legacy per-doc watermark so the deploy doesn't trigger a full-catalog
 * import.
 */
export async function getLegacyWatermark(DL, field) {
    const doc = await DL.ComaxProduct.Model.findOne({}, { _id: 0, [field]: 1 })
        .sort({ [field]: -1 })
        .lean()
    if (doc?.[field]) return new Date(doc[field])
    return null
}

/**
 * Where the current import should start.
 *   { from: Date|null, source: 'state'|'legacy'|'none' }
 */
export async function resolveImportStart(DL, key, legacyField) {
    const watermark = await getWatermark(DL, key)
    if (watermark) return { from: watermark, source: 'state' }
    const legacy = await getLegacyWatermark(DL, legacyField)
    if (legacy) return { from: legacy, source: 'legacy' }
    return { from: null, source: 'none' }
}

export async function setSyncState(DL, key, fields = {}) {
    await DL.ComaxSyncState.updateOne({ key }, { $set: fields }, { upsert: true })
}

/**
 * Close out a run.
 *
 * `advance` must only be true when the delta is fully written. A failed
 * batch or an unparseable item means those products are missing from the DB,
 * so the old watermark has to stay and the next run re-fetches the same
 * window (upserts are idempotent — the cost is one repeated window).
 */
export async function completeRun(DL, key, { startedAt, processed = 0, failed = 0, unparsed = 0, error = null, advance = false, status = null }) {
    const fields = {
        status: status || (error ? 'error' : (advance ? 'success' : 'partial')),
        processed,
        failed: failed + unparsed,
        startedAt,
        finishedAt: new Date()
    }
    if (error) fields.error = String(error?.message || error).slice(0, 500)
    if (advance) fields.lastSyncAt = startedAt

    await setSyncState(DL, key, fields)
    return fields
}
