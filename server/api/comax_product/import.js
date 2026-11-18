import mem, { collectGarbage } from '#server/utils/mem.js'
import { round2 } from '#common/functions/calcOrder/utils.js'
import { PRODUCTS, completeRun } from './watermark.js'
import { resolveFreshDepartments } from './freshDepartments.js'
import { resolveSalesWindow, buildDepartmentWindows, buildKeptBarcodes, sumSalesUnits } from './salesWindow.js'

const REGISTER_FILTER = { active: true, type: 'comax' }

function chunk(array, size) {
    if (!array.length) return []
    if (array.length <= size) return [array]
    const parts = []
    for (let i = 0; i < array.length; i += size) parts.push(array.slice(i, i + size))
    return parts
}

/**
 * Import what each store can actually sell, plus the counters Comax does not
 * stock-manage.
 *
 *   store feed       one Get_AllItemsDetailsBySearch per active cash register
 *                    with HasInventory=1 → the complete in-stock set of that
 *                    store (well under the 17,000-item cap, never truncated)
 *   department feed  one call per configured fresh department without
 *                    HasInventory (produce, butcher, fish, bakery, deli…)
 *
 * Both feeds are snapshots: `LastUpdatedFromDate` stays empty, so there is no
 * watermark to advance. `comax_sync_state` only records the run status and the
 * per-feed sizes used by the collapse guard.
 *
 * Absence from the response now means "out of stock", and that inference is
 * only safe when the response is complete — hence the guards: an empty,
 * truncated or collapsed feed never removes a storeIds entry.
 *
 * Neither feed asks Comax to select by price list. That filter answers nothing
 * for an item with no entry in 1069/255, so an unpriced counter item could sell
 * every day for a month without ever becoming a row. Its selling price is written
 * as 0 so a stale one cannot survive; the buying price keeps whatever Comax or the
 * buying price CSV gave it. Either way the status ladder archives the row, so it
 * cannot reach the site, and the catalog report lists it as חסר מחיר — being seen
 * is the entire point.
 *
 * A price-less item only gets a row when something says it matters today: a store
 * feed carries it in stock, it sold inside its window, Comax prices it for buying,
 * or a row already exists. The department feeds list every item in the department —
 * stocked or not — and without that gate they invent thousands of rows for counter
 * items nothing sells and nothing buys.
 */
export default async function importComaxProducts(payload, { DL, external }) {
    const startedAt = new Date()

    // Batched writes over a streamed response: one item in memory at a time.
    const BATCH = Number(process.env.COMAX_IMPORT_BATCH || 1000)
    const STREAM_TIMEOUT_MS = Number(process.env.COMAX_STREAM_IDLE_TIMEOUT_MS || 600000)
    const GC_EVERY = Number(process.env.COMAX_IMPORT_GC_EVERY || 20)
    const PULL_CHUNK = Number(process.env.COMAX_STORE_PULL_CHUNK || 5000)

    // Get_AllItemsDetailsBySearch silently truncates at 17,000 items. A feed
    // sitting at the cap is missing products, so it may add but never remove.
    const ITEM_CAP = Number(process.env.COMAX_RESPONSE_ITEM_CAP || 17000)
    // A response far smaller than the previous run's is suspicious even when it
    // is not empty: Comax has answered from a half-built spool before.
    const MIN_PREVIOUS = Number(process.env.COMAX_FEED_MIN_PREVIOUS || 100)
    const COLLAPSE_RATIO = Number(process.env.COMAX_FEED_COLLAPSE_RATIO || 0.5)

    const previousState = await DL.ComaxSyncState
        .readOne({ key: PRODUCTS }, { _id: 0, feeds: 1 })
        .catch(() => null)
    const previousFeeds = previousState?.feeds || {}

    const registers = await DL.CashRegister.read(REGISTER_FILTER, { _id: 0, storeId: 1, data: 1 }, { limit: 0 })
    if (!registers?.length) {
        console.warn('[Comax Import] No active Comax cash registers — nothing to import')
        await completeRun(DL, PRODUCTS, { startedAt, status: 'skipped' })
        return { message: 'No active cash registers', count: 0 }
    }

    const storeIds = [...new Set(registers.map(r => r.storeId).filter(Boolean))]
    const feeds = {}
    const results = []
    const errors = []
    let written = 0
    let failedDocs = 0
    let unparsedDocs = 0
    let batchNo = 0

    // A product's TrailingItem is the deposit product charged next to it
    // (e.g. 0.30 for a bottle). Deposit products live in super-department 12,
    // which the catalog feeds exclude, so they are resolved on demand by Comax
    // id and cached for the whole run (a handful of ids at most).
    const trailingCache = new Map()

    const resolveTrailingItem = async id => {
        const key = String(id)
        if (trailingCache.has(key)) return trailingCache.get(key)

        let product = null
        if (typeof external.comax?.getItemById === 'function') {
            try {
                product = await external.comax.getItemById({ itemId: key })
            } catch (e) {
                console.warn(`[Comax Import] trailing item ${key} could not be read:`, e?.message || e)
            }
        }
        trailingCache.set(key, product)
        return product
    }

    // Fill the calculated price next to the original Comax price. A failed
    // lookup leaves the item at its own price instead of inventing a deposit.
    const applyTrailingItem = async p => {
        if (!p.trailingItemId) return

        const trailing = await resolveTrailingItem(p.trailingItemId)
        if (!trailing) return

        const quantity = Number(p.trailingItemQuantity) || 1
        const price = Number(trailing.price) || 0
        p.trailingItemPrice = price
        p.trailingPrice = round2(price * quantity)
        if (p.price > 0) p.priceWithTrailing = round2(p.price + p.trailingPrice)
    }

    // Fields that only describe a trailing item. Products without one must not
    // carry them at all (a null/0 default on 40k rows is just noise), so the
    // update removes them explicitly instead of writing empty values.
    const TRAILING_FIELDS = ['trailingItemId', 'trailingItemQuantity', 'trailingItemPrice', 'trailingPrice', 'priceWithTrailing']
    const RESOLVED_TRAILING_FIELDS = ['trailingItemPrice', 'trailingPrice', 'priceWithTrailing']

    const writeBatch = async (docs, addStoreIds) => {
        await DL.ComaxProduct.bulkWrite({
            docs,
            getFilter: p => ({ barcode: p.barcode }),
            // The store feed owns creation, and an item it carried is an item the
            // store has — including one Comax lists without a price. The status
            // ladder archives a price-less row, so creating one cannot put anything
            // on the site; it is what lets a counter item that sells unpriced show
            // up in the catalog report instead of never being seen at all. Archived
            // items stay out: those rows belong to the catalog backfill, which
            // writes them flagged. Deposit products are internal, so they are
            // upserted by their own write even though they never appear in a feed.
            // A price-less item from a fresh department is filtered before it gets
            // here (see the feed gate), so what reaches this point has a price, is
            // stocked somewhere, sold, or is bought at a price Comax knows.
            getUpsert: p => p.isTrailingItem || !p.archived,
            getUpdate: p => {
                // storeIds is owned by $addToSet, never by $set — a feed only
                // asserts "in stock here", it never replaces other stores.
                const { storeIds: _storeIds, ...fields } = p
                let $unset

                if (!p.trailingItemId) {
                    for (const key of TRAILING_FIELDS) delete fields[key]
                    $unset = Object.fromEntries(TRAILING_FIELDS.map(key => [key, '']))
                } else if (p.trailingPrice == null) {
                    // The reference is known but the deposit could not be
                    // resolved this run: keep the reference, drop stale prices.
                    for (const key of RESOLVED_TRAILING_FIELDS) delete fields[key]
                    $unset = Object.fromEntries(RESOLVED_TRAILING_FIELDS.map(key => [key, '']))
                } else if (p.priceWithTrailing == null) {
                    delete fields.priceWithTrailing
                    $unset = { priceWithTrailing: '' }
                }

                const $addToSet = addStoreIds.length
                    ? { storeIds: addStoreIds.length === 1 ? addStoreIds[0] : { $each: addStoreIds } }
                    : null
                return {
                    $set: fields,
                    ...($unset ? { $unset } : {}),
                    ...($addToSet ? { $addToSet } : {})
                }
            }
        })
    }

    /**
     * Stream one feed into comax_products and report how trustworthy its
     * "absent = out of stock" reading is.
     */
    const runFeed = async ({ key, label, addStoreIds, stream, gate }) => {
        const stats = { blocks: 0, kept: 0, unparsed: 0 }
        const barcodes = new Set()
        let batch = []
        let count = 0
        let failed = 0
        let unpriced = 0
        let gated = 0
        let errored = null

        const flush = async () => {
            if (!batch.length) return
            const docs = batch
            batch = []
            batchNo++
            try {
                await writeBatch(docs, addStoreIds)
            } catch (e) {
                failed += docs.length
                console.error(`[Comax Import] ${label} batch ${batchNo} failed:`, e?.message || e)
            }
            count += docs.length
            mem(`${label}: ${count} products`, 'ComaxImport')
            if (GC_EVERY > 0 && batchNo % GC_EVERY === 0) collectGarbage()
        }

        try {
            for await (const p of stream(stats)) {
                p.lastImportedAt = startedAt
                // No sell price in the response means no entry in 1069: item.Price IS
                // the retail price of the requested price list, so 0 is Comax saying
                // "this item has no selling price". Write it instead of leaving the
                // row untouched, or a price from the last time it had one survives and
                // the report shows a number where the gap is.
                //
                // The buying price keeps the mapper's rule and is NOT touched here: a
                // 255 row with 0 already clears it, and a 255 row that is simply absent
                // means the feed has no opinion — that price can come from the buying
                // price CSV instead. Plenty of counter items have a buying price and
                // no selling price (139232 מסטר נתחים צלעות בקר טרי חלק: 42 to buy,
                // nothing to sell for), and that is exactly the gap the report should
                // name.
                if (!(p.price > 0)) {
                    p.price = 0
                    // The department feeds assert nothing about stock, so a price-less
                    // item from them only earns a row when Comax prices it for buying,
                    // it sold, or a row of its own already exists.
                    if (gate && !gate(p)) { gated++; continue }
                    unpriced++
                }
                await applyTrailingItem(p)
                if (p.barcode != null) barcodes.add(String(p.barcode))
                batch.push(p)
                if (batch.length >= BATCH) await flush()
            }
            await flush()
        } catch (e) {
            await flush()
            errored = e?.message || String(e)
            errors.push({ key, message: errored })
            console.error(`[Comax Import] ${label} failed:`, errored)
        }

        const blocks = stats.blocks
        const empty = !errored && blocks === 0
        const truncated = blocks >= ITEM_CAP
        const previous = Number(previousFeeds[key] ?? 0)
        const collapsed = !errored && previous >= MIN_PREVIOUS && blocks < previous * COLLAPSE_RATIO

        if (empty) console.warn(`[Comax Import] ${label} returned no items — keeping the stored stock state`)
        if (truncated) console.error(`[Comax Import] ${label} hit the ${ITEM_CAP}-item cap (${blocks}) — additions only`)
        if (collapsed) console.warn(`[Comax Import] ${label} returned ${blocks} items, down from ${previous} — additions only`)

        const removalsSafe = !errored && !empty && !truncated && !collapsed &&
            failed === 0 && stats.unparsed === 0

        // Only remember a feed size that came from a complete response:
        // a truncated or errored one must not poison the next comparison.
        if (!errored && !truncated && stats.unparsed === 0) feeds[key] = blocks

        written += count
        failedDocs += failed
        unparsedDocs += stats.unparsed
        if (gated)
            console.log(`[Comax Import] ${label}: ${gated} item(s) skipped — no price in Comax, not in stock, did not sell`)

        results.push({ key, label, barcodes, removalsSafe, blocks, count, failed, unpriced, gated })
    }

    // 0. Sales window FETCH — before the feeds, because "did it sell inside its
    //    window" is what decides whether an item Comax lists without a price
    //    deserves a row at all (the department feeds' gate). The WRITES of this
    //    step stay after the feeds: a store id only exists because a feed asserted
    //    one, and the removals must read the state the feeds just wrote.
    //
    //    This step only REMOVES. A failed, empty or collapsed response therefore
    //    leaves the stored state untouched instead of mass-deleting it.
    let windowRemoved = 0
    let windowSkipped = 0
    // Sold items with no Comax row at all: invisible to the catalog report, and no
    // feed is allowed to invent one from a sales row. Counted and named so the gap
    // is fixable.
    let soldWithoutRow = 0
    let windows = null
    // Per register: the barcodes that sold inside their department's window.
    const soldPerRegister = []
    // Every barcode that sold somewhere in the window, across all stores.
    const soldBarcodes = new Set()
    const lastSaleByBarcode = new Map()
    // Units sold per barcode, summed over the stores. Written only when
    // every store answered: a skipped store would silently under-count,
    // and a wrong total is worse than yesterday's.
    const salesUnitsByBarcode = new Map()
    let salesUnitsComplete = true

    const salesWindow = await resolveSalesWindow(DL)

    if (!salesWindow.enabled) {
        console.log('[Comax Import] Sales window disabled (no positive window configured)')
    } else if (typeof external.comax?.streamSalesWindow !== 'function') {
        console.warn('[Comax Import] Sales window unavailable in this Comax client — skipping')
    } else {
        windows = buildDepartmentWindows(salesWindow)
        console.log(`[Comax Import] Sales window: default ${windows.defaultDays}d, ` +
            `${windows.byDepartment.size} department override(s), querying ${windows.maxDays}d`)

        for (const reg of registers) {
            const comaxStoreId = String(reg.data?.StockStoreID ?? '').trim()
            if (!comaxStoreId) {
                salesUnitsComplete = false
                continue
            }

            const stats = { blocks: 0, kept: 0, unparsed: 0 }
            const rows = []
            let errored = null

            try {
                for await (const row of external.comax.streamSalesWindow({
                    storeId: comaxStoreId,
                    days: windows.maxDays,
                    timeoutMs: STREAM_TIMEOUT_MS,
                    stats
                })) rows.push(row)
            } catch (e) {
                errored = e?.message || String(e)
                console.error(`[Comax Import] store ${reg.storeId}: sales window failed:`, errored)
                errors.push({ key: `salesWindow:${reg.storeId}`, message: errored })
            }

            const { kept, lastSale, unknownDates } = buildKeptBarcodes(rows, windows)
            for (const [barcode, date] of lastSale) {
                const previous = lastSaleByBarcode.get(barcode)
                if (!previous || date > previous) lastSaleByBarcode.set(barcode, date)
            }

            const key = `salesWindow:${reg.storeId}`
            const previous = Number(previousFeeds[key] ?? 0)
            const empty = !errored && stats.blocks === 0
            const collapsed = !errored && previous >= MIN_PREVIOUS && stats.blocks < previous * COLLAPSE_RATIO
            const unparseable = stats.unparsed > 0

            // Only remember a size that came from a complete, non-empty
            // response. An empty answer is exactly the suspicious case, and
            // overwriting the healthy baseline with 0 would disarm the collapse
            // guard for the next run. A skipped store keeps its last known
            // size, so the guard still works after a bad night.
            if (!errored && !unparseable && stats.blocks > 0) feeds[key] = stats.blocks
            else if (previous > 0) feeds[key] = previous

            if (errored || empty || collapsed || unparseable) {
                windowSkipped++
                const reason = errored
                    ? `feed failed (${errored})`
                    : empty
                        ? 'feed returned no items'
                        : collapsed
                            ? `feed returned ${stats.blocks} items, down from ${previous}`
                            : `${stats.unparsed} unparseable block(s)`
                console.warn(`[Comax Import] store ${reg.storeId}: sales window skipped, keeping stored stock state — ${reason}`)
                salesUnitsComplete = false
                continue
            }

            soldPerRegister.push({ reg, kept })
            for (const barcode of kept) soldBarcodes.add(barcode)
            sumSalesUnits(rows, salesUnitsByBarcode)

            if (unknownDates)
                console.warn(`[Comax Import] store ${reg.storeId}: ${unknownDates} sold row(s) without a usable LastSaleDate — kept`)
        }
    }

    // Barcodes that already have a row are never gated: the catalog backfill (the
    // CSV on the Comax products page) and the buying price CSV own those rows, and
    // the import has to keep refreshing one even in a month the item sells nothing.
    const norm = barcode => String(barcode ?? '').trim()
    const existingBarcodes = new Set(((await DL.ComaxProduct.Model.distinct('barcode', {})) || []).map(norm))
    // What makes a price-less department item worth a row: it sold inside its window,
    // it already has a row, or Comax prices it for buying (it buys the item and has
    // nothing to sell it for — that is a price-list gap, not noise). Only an item
    // Comax has no price for at all needs to be stocked or sold to be seen.
    const pricelessIsWanted = p =>
        p.buyingPrice > 0 || soldBarcodes.has(norm(p.barcode)) || existingBarcodes.has(norm(p.barcode))

    console.log(`[Comax Import] Store feed: ${registers.length} register(s), ${storeIds.length} store(s)`)
    mem('start', 'ComaxImport')

    // 1. Per-store in-stock feed.
    let firstComaxStoreId = ''
    for (const reg of registers) {
        const comaxStoreId = String(reg.data?.StockStoreID ?? '').trim()
        if (!comaxStoreId) {
            const message = 'missing StockStoreID — set cash_register.data.StockStoreID'
            console.error(`[Comax Import] store ${reg.storeId}: ${message}`)
            errors.push({ key: `store:${reg.storeId}`, message })
            continue
        }
        firstComaxStoreId ||= comaxStoreId

        // Optional count cross-check against the balance endpoint. Off by
        // default: it is a second multi-MB call per store and its result is
        // scoped by ChangesAfter, so a gap is informational at best.
        if (process.env.COMAX_BALANCE_CROSSCHECK === 'true' && typeof external.comax.getBalance === 'function') {
            try {
                const balances = await external.comax.getBalance({ storeId: comaxStoreId })
                const inStock = balances.filter(b => !b.error && b.balance > 0).length
                console.log(`[Comax Import] store ${reg.storeId}: items feed vs balance = ${inStock}`)
            } catch (e) {
                console.warn(`[Comax Import] store ${reg.storeId}: balance cross-check failed:`, e?.message || e)
            }
        }

        await runFeed({
            key: `store:${reg.storeId}`,
            label: `store ${reg.storeId} (Comax ${comaxStoreId})`,
            addStoreIds: [reg.storeId],
            stream: stats => external.comax.streamStoreProducts({
                storeId: comaxStoreId,
                timeoutMs: STREAM_TIMEOUT_MS,
                stats
            })
        })
    }

    // 2. Fresh (not stock-managed) departments. The response is
    // store-independent, so these items are in stock in every active store.
    const freshDepartments = await resolveFreshDepartments(DL)
    console.log(`[Comax Import] Fresh departments: ${freshDepartments.join(', ')}`)

    for (const departmentId of freshDepartments) {
        await runFeed({
            key: `department:${departmentId}`,
            label: `department ${departmentId}`,
            addStoreIds: storeIds,
            // Comax answers every item in the department, stocked or not. A price-less
            // one is only worth a row when it sold inside its window, already has a row
            // of its own, or Comax prices it for buying.
            gate: pricelessIsWanted,
            stream: stats => external.comax.streamDepartmentProducts({
                departmentId,
                storeId: firstComaxStoreId || undefined,
                timeoutMs: STREAM_TIMEOUT_MS,
                stats
            })
        })
    }

    // 2b. Deposit products referenced by the feeds. They are never catalog
    // items, so each one is written on its own; the parent already carries the
    // reference and the calculated price. A failed lookup simply leaves the
    // parent at its own price until the next run.
    const trailingDocs = [...trailingCache.values()]
        .filter(trailing => trailing?.barcode)
        .map(trailing => ({ ...trailing, isTrailingItem: true, lastImportedAt: startedAt }))
    if (trailingDocs.length) {
        try {
            await writeBatch(trailingDocs, [])
            written += trailingDocs.length
            console.log(`[Comax Import] ${trailingDocs.length} trailing item(s): ${trailingDocs.map(t => t.barcode).join(', ')}`)
        } catch (e) {
            failedDocs += trailingDocs.length
            console.error('[Comax Import] trailing items batch failed:', e?.message || e)
        }
    }

    // 3. Removals. Only a run in which every feed was complete may conclude
    // that a barcode is out of stock: a single empty/failed fresh department
    // would otherwise hide its whole counter.
    let removed = 0
    const incomplete = results.filter(r => !r.removalsSafe)
    if (incomplete.length) {
        console.warn(`[Comax Import] Skipping storeIds removals — incomplete feed(s): ${incomplete.map(r => r.label).join(', ')}`)
    } else {
        const freshBarcodes = new Set()
        for (const r of results) {
            if (!r.key.startsWith('department:')) continue
            for (const barcode of r.barcodes) freshBarcodes.add(barcode)
        }

        for (const reg of registers) {
            const feed = results.find(r => r.key === `store:${reg.storeId}`)
            if (!feed) continue

            const keep = new Set(feed.barcodes)
            for (const barcode of freshBarcodes) keep.add(barcode)

            const current = await DL.ComaxProduct.Model.distinct('barcode', { storeIds: reg.storeId })
            const stale = (current || []).filter(barcode => !keep.has(barcode))
            if (!stale.length) continue

            for (const part of chunk(stale, PULL_CHUNK)) {
                const res = await DL.ComaxProduct.Model.updateMany(
                    { barcode: { $in: part }, storeIds: reg.storeId },
                    { $pull: { storeIds: reg.storeId } }
                )
                removed += res?.modifiedCount || 0
            }
            console.log(`[Comax Import] store ${reg.storeId}: ${stale.length} item(s) no longer in stock`)
        }
    }

    // 3b. Store ids that no longer belong to an active register can never be
    // asserted by a feed again, so they are stale by definition. Independent of
    // feed completeness (the register list is DB state), but guarded so an empty
    // register list can never empty the catalog.
    let prunedStoreIds = 0
    if (storeIds.length) {
        const res = await DL.ComaxProduct.Model.updateMany(
            { storeIds: { $exists: true } },
            { $pull: { storeIds: { $nin: storeIds } } }
        )
        prunedStoreIds = res?.modifiedCount || 0
        if (prunedStoreIds) console.log(`[Comax Import] ${prunedStoreIds} item(s) dropped a store id of an inactive register`)
    }

    // 4. Sales window writes. The Comax calls for this step ran before the feeds
    // (step 0); only the writes are here, because a store id exists solely because
    // a feed asserted one and the removals must read the state the feeds just wrote.
    if (windows) {
        for (const { reg, kept } of soldPerRegister) {
            const current = await DL.ComaxProduct.Model.distinct('barcode', { storeIds: reg.storeId })
            const stale = (current || []).filter(barcode => !kept.has(barcode))
            if (!stale.length) {
                console.log(`[Comax Import] store ${reg.storeId}: every in-stock item sold inside its window`)
                continue
            }

            for (const part of chunk(stale, PULL_CHUNK)) {
                const res = await DL.ComaxProduct.Model.updateMany(
                    { barcode: { $in: part }, storeIds: reg.storeId },
                    { $pull: { storeIds: reg.storeId } }
                )
                windowRemoved += res?.modifiedCount || 0
            }
            console.log(`[Comax Import] store ${reg.storeId}: ${stale.length} item(s) not sold inside their window`)
        }

        // A sold barcode with no comax_products row cannot appear in the catalog
        // report, and no feed can invent one from a sales row: it is either a
        // super-department 12 deposit item or an item Comax answers no catalog data
        // for. Naming the codes is what makes the gap fixable — the catalog
        // backfill on the Comax products page takes exactly these codes.
        if (lastSaleByBarcode.size) {
            // Read after the feeds: an item a feed carried is a row by now, and only
            // what still has none is a gap.
            const stored = new Set(((await DL.ComaxProduct.Model.distinct('barcode', {})) || []).map(norm))
            const missing = [...lastSaleByBarcode.keys()].filter(barcode => !stored.has(barcode))
            soldWithoutRow = missing.length
            if (missing.length)
                console.warn(`[Comax Import] ${missing.length} sold item(s) have no catalog row: ` +
                    `${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ' …' : ''}`)
        }

        // Newest sale per barcode, across stores — informational, for the admin.
        if (lastSaleByBarcode.size) {
            const ops = [...lastSaleByBarcode].map(([barcode, lastSaleDate]) => ({
                updateOne: { filter: { barcode }, update: { $max: { lastSaleDate } } }
            }))
            try {
                for (const part of chunk(ops, BATCH)) await DL.ComaxProduct.Model.bulkWrite(part)
            } catch (e) {
                console.warn('[Comax Import] Could not store lastSaleDate:', e?.message || e)
            }
        }

        // Units sold per barcode over the window, summed across stores. This is
        // a total, not a running max, so it is replaced every run: an item that
        // sold nothing in the window goes back to 0 and stops ranking as
        // popular. Both halves are skipped unless every store answered — a
        // partial sum would quietly demote products from the missing store.
        if (!salesUnitsComplete) {
            console.warn('[Comax Import] Sales units not stored — at least one store feed was skipped')
        } else if (!salesUnitsByBarcode.size) {
            console.warn('[Comax Import] Sales units not stored — no store reported a positive SalesLastDays')
        } else {
            const ops = [...salesUnitsByBarcode].map(([barcode, salesLastDays]) => ({
                updateOne: { filter: { barcode }, update: { $set: { salesLastDays } } }
            }))
            try {
                // Values first: a failure there leaves the old numbers in place
                // instead of zeroing items that did sell.
                for (const part of chunk(ops, BATCH)) await DL.ComaxProduct.Model.bulkWrite(part)
                const zeroed = await DL.ComaxProduct.Model.updateMany(
                    { barcode: { $nin: [...salesUnitsByBarcode.keys()] } },
                    { $set: { salesLastDays: 0 } }
                )
                console.log(`[Comax Import] Sales units: ${salesUnitsByBarcode.size} item(s) sold, ` +
                    `${zeroed?.modifiedCount || 0} reset to 0`)
            } catch (e) {
                console.warn('[Comax Import] Could not store salesLastDays:', e?.message || e)
            }
        }
    }

    // Items the feeds carried with no price in either list. The written ones are
    // stocked or sold, and the status ladder keeps them off the site until Comax
    // gives them a price — the point is that they are in comax_products and in the
    // catalog report at all. The skipped ones are department items nothing sells.
    const noPrice = results.reduce((sum, feed) => sum + feed.unpriced, 0)
    const noPriceSkipped = results.reduce((sum, feed) => sum + (feed.gated || 0), 0)

    const anyIncomplete = incomplete.length > 0 || errors.length > 0
    const status = written === 0 && anyIncomplete ? 'error' : anyIncomplete || failedDocs > 0 ? 'partial' : 'success'

    await completeRun(DL, PRODUCTS, {
        startedAt,
        processed: written - failedDocs,
        failed: failedDocs,
        unparsed: unparsedDocs,
        status,
        error: errors[0]?.message,
        feeds
    })

    const summary = `[Comax Import] ${written} item(s) from ${results.length} feed(s), ` +
        `${noPrice} without a price in Comax` +
        `${noPriceSkipped ? ` (${noPriceSkipped} skipped: not in stock, did not sell)` : ''}, ` +
        `${soldWithoutRow ? `${soldWithoutRow} sold item(s) with no catalog row, ` : ''}` +
        `${removed} out-of-stock removal(s), ${windowRemoved} not-sold-in-window removal(s), ` +
        `${prunedStoreIds} stale-store removal(s)` +
        `${windowSkipped ? ` (${windowSkipped} store(s) kept as-is)` : ''}, status ${status}`

    if (anyIncomplete) {
        console.warn(summary)
        return { message: 'Import partially failed', count: written, noPrice, noPriceSkipped, soldWithoutRow, removed: removed + windowRemoved, prunedStoreIds, status, errors }
    }

    console.log(summary)
    return { message: 'Import complete', count: written, noPrice, noPriceSkipped, soldWithoutRow, removed: removed + windowRemoved, prunedStoreIds, status }
}

importComaxProducts.config = {
    permissions: ['comax_product:update']
}
