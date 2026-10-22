// Watermark + run status for the Comax catalog import (keyed docs).
// key 'products'     → { lastSyncAt } — the delta the next import starts from.
// key 'buyingPrices' → { lastSyncAt }
// The watermark advances ONLY after a fully successful run, so a run that
// died half way re-fetches the same delta next time instead of silently
// losing the products it never wrote.

const comaxSyncStateSchema = {
    key: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        filter: true
    },
    lastSyncAt: Date,
    status: String,
    processed: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    startedAt: Date,
    finishedAt: Date,
    error: String
}

export const meta = {}

export default comaxSyncStateSchema
