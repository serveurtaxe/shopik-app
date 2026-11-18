// Full GS1 payload store — one doc per GTIN. Keeps the heavy supplier JSON
// (nutrition tables, EU fields, media metadata) out of the Product collection.
// Product keeps only light pointers: gs1ProductCode + gs1SyncedAt.

const gs1ProductSchema = {
    barcode: {
        type: String,
        required: true,
        unique: true,
        trim: true,
        filter: true
    },
    productCode: {
        type: String,
        trim: true,
        index: true
    },
    modificationTime: Date,
    assetCount: Number,
    // Pipeline status: fetched (raw dumped, awaiting enrich) → enriched | skipped:<reason>
    status: {
        type: String,
        default: 'fetched',
        index: true,
        filter: true
    },
    skipReason: String,
    // Short-barcode resolution: 'ambiguous' = 2+ product barcodes match this
    // GTIN and an admin must pick one; 'manual' = aliasShort was confirmed in
    // the admin UI (it wins over suffix guessing); 'auto' = resolved by exact
    // or suffix matching. Empty/absent means no alias state.
    // filter:'exact' (not true): closed vocabulary queried by full value.
    // The default prefix treatment rewrote it to /^ambiguous/i — a
    // case-insensitive regex the {aliasStatus} index cannot serve — so the
    // gs1/aliases page scanned all 12.6k docs (and their heavy raw payloads)
    // plus a second scan for the count, to return a 50-row page.
    aliasStatus: {
        type: String,
        filter: 'exact'
    },
    aliasShort: {
        type: String,
        trim: true
    },
    aliasCandidates: [String],
    aliasUpdatedAt: Date,
    // Set when the zip is staged, so enrich can process images without GS1 calls.
    fingerprint: String,
    stagingPath: String,
    imagesDone: Boolean,
    raw: {},
    syncedAt: {
        type: Date,
        default: Date.now
    }
}

export const meta = {
    index: [
        // gs1/aliases page: {aliasStatus} equality + sort by barcode + limit —
        // one range serves filter and order (no FETCH, no in-memory sort) and
        // makes the route's count a covered key-scan of just the status prefix.
        [{ aliasStatus: 1, barcode: 1 }],
        // The catalog report reads the `no-gs1-record` rows twice over: the dated
        // "לא נבדק" answer and the barcodes GS1 does not hold. Unindexed, both were a
        // COLLSCAN of all 23 449 docs — 7.3 kB each, ~163 MB of disk reads per report
        // build, and the two top entries of Atlas's index advisor for this collection.
        // Indexed: 684 docs, 1 ms.
        { skipReason: 1 }
    ]
}

export default gs1ProductSchema
