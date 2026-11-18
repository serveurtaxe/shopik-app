import pLimit from 'p-limit'
import log from '#server/utils/log.js'
import { round2 } from '#common/functions/calcOrder/utils.js'
import { parseCsv } from '#server/external/comax/buyingPriceCsv.js'
import { buildSalesPriceArray } from '#server/external/comax/utils.js'
import { enqueueFetchJobs } from '#server/queues/gs1Queues.js'
import { gtinOf } from '#server/services/gs1/gtin.js'

/**
 * Catalog backfill — the Comax items the nightly import never brought in.
 *
 * The import is a STOCK feed: one HasInventory call per store plus the fresh
 * departments. An item that is not in stock anywhere is simply absent from the
 * response, so it never becomes a comax_products row and never reaches the
 * catalog report. A full-catalog export from Comax gives the item codes; this
 * reads each one by its Comax item ID and inserts the missing row.
 *
 * Archived items ARE written, flagged `archived: true`. Comax uses its archive
 * for seasonal products: they leave the catalog between seasons and come back
 * later. The lookups ask with WithOutArchive=0 so those items are returned, and
 * the row is stored with no storeIds so the status ladder can never put it on
 * the site while Comax still reports it archived. Having the row (and its GS1
 * lookup) ready is what lets images and kashrut be in place on the day the item
 * returns instead of starting the pipeline then. The nightly import clears the
 * flag when the item is un-archived and a store feed stocks it.
 *
 * An item Comax carries WITHOUT a price-list entry is written too. The lookups
 * filter on SelByPriceList (that is where the buying price comes from), and Comax
 * answers an empty body for an item that has no entry in 1069 or 255 — the butcher
 * scale codes 43001 בקר טחון מחפוד, 43209 צלעות מחפוד and the rest of that block.
 * Those are real items with nothing missing except a price, so a second look
 * without the filter stores them and the report shows them as חסר מחיר קנייה
 * instead of pretending they do not exist.
 *
 * Writes only create rows for anything the import owns: the update is
 * $setOnInsert, so an existing row — its price, its storeIds, an admin's edit —
 * is never touched, and a code that already matches a stored barcode or comaxId
 * is skipped before any request. Rows an earlier backfill created are the one
 * exception: they are refreshed, because no store feed will ever update them.
 *
 * dryRun (the default) makes no Comax call at all: it plans and counts. A run
 * processes `limit` codes and reports `remaining`, so the modal repeats the call
 * instead of pushing 4,000 lookups through one HTTP request.
 *
 * gs1 enqueues a GS1 lookup for the barcodes this run created, through the
 * normal fetch queue (its limiter paces the sweep). Codes that are not plausible
 * GTINs are filtered out here — see services/gs1/gtin.js.
 *
 * POST /api/comax_product/backfill_catalog { csv, dryRun?, limit?, concurrency?, gs1? }
 */

const CSV_HEADER = 'ברקוד קומקס'
const MAX_CSV_CHARS = 3_000_000
const DEFAULT_LIMIT = 500
const DEFAULT_CONCURRENCY = 20
const MAX_CONCURRENCY = 50
const WRITE_CHUNK = 500
const COMAX_RETRIES = 3
const COMAX_TIMEOUT_MS = 20000
const SAMPLE_CAP = 20

// Comax and Shopik disagree on leading zeros often enough that a raw string
// compare leaves duplicates behind ('01001004' vs '1001004').
const normalizeCode = code => String(code ?? '').trim().replace(/^0+(?=\d)/, '')

const normHeader = value => String(value ?? '').replace(/[\s\u05f4"']/g, '')

function chunk(array, size) {
    const parts = []
    for (let i = 0; i < array.length; i += size) parts.push(array.slice(i, i + size))
    return parts
}

/**
 * Item codes from the catalog export, in file order, without repeats.
 *
 * The export's first column is the Comax item code (its header says "ברקוד
 * קומקס"); the columns after it are a secondary barcode and free text, which
 * are not data for this job. When the header is missing or renamed the first
 * column is used — every row is validated as a numeric Comax id either way.
 *
 * A Comax item code is usually the item's EAN-13, but it is not always one: the
 * same column holds internal ids (10068012), 11-12 digit codes, and pack codes
 * that hang a suffix off the EAN (729000013534227). All of them are readable by
 * ItemID, so the only thing rejected here is something that is not a number.
 *
 * The code is kept as written; the leading-zero-insensitive form is only the
 * key used to compare it against what is already stored.
 */
export function parseCatalogCsv(text) {
    const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
    const rows = parseCsv(src)
    const body = rows.slice(1)

    const header = (rows[0] || []).map(normHeader)
    const found = header.indexOf(normHeader(CSV_HEADER))
    const col = found >= 0 ? found : 0

    const codes = []
    const seen = new Set()
    const invalid = []
    for (const row of body) {
        const code = String(row[col] ?? '').trim()
        if (!code) continue
        if (!/^\d{1,16}$/.test(code)) {
            if (invalid.length < SAMPLE_CAP) invalid.push(code)
            continue
        }
        const key = normalizeCode(code)
        if (seen.has(key)) continue
        seen.add(key)
        codes.push(code)
    }

    return { codes, invalid, rows: body.length }
}

/** Codes that are already catalog rows, under either key. */
export async function readKnownCodes(DL) {
    const [barcodes, comaxIds] = await Promise.all([
        DL.ComaxProduct.Model.distinct('barcode'),
        DL.ComaxProduct.Model.distinct('comaxId')
    ])
    const known = new Set()
    for (const value of [...(barcodes || []), ...(comaxIds || [])]) {
        const key = normalizeCode(value)
        if (key) known.add(key)
    }
    return known
}

/**
 * A backfilled row is created as "not in stock anywhere". That is exactly the
 * state the import leaves an item in when no store feed carries it, and it is
 * what keeps the status ladder honest: an item nobody stocks must not become a
 * live product just because GS1 has an image for it. The nightly import adds
 * store ids back the moment the item sells somewhere.
 */
export function buildBackfilledRow(product, { startedAt }) {
    return {
        ...product,
        storeIds: [],
        backfilledAt: startedAt
    }
}

/**
 * Hand the barcodes this run created to the GS1 fetch queue.
 *
 * Only plausible GTINs are asked about (services/gs1/gtin.js), and the queue's
 * own limiter paces the sweep. `enqueue` is a parameter so the selection and the
 * run record can be tested without Redis.
 */
export async function queueGs1Lookups({ DL, barcodes, startedAt, enqueue = enqueueFetchJobs }) {
    const gtins = [...barcodes].map(gtinOf).filter(Boolean)
    // Same doc shape gs1/sync writes for its own runs (gs1_sync_state is keyed
    // `run:<id>`), so the drain of a 3,600-code sweep is watched the same way.
    const runId = `run:backfill-${startedAt.getTime()}`
    await DL.Gs1SyncState.updateOne(
        { key: runId },
        { $set: { status: 'running', total: gtins.length, processed: 0, failed: 0, startedAt } },
        { upsert: true }
    )
    const { enqueued } = await enqueue(gtins.map(productCode => ({ productCode, runId })))
    return { runId, enqueued, notGtin: barcodes.size - gtins.length }
}

export default async function backfillCatalog(payload = {}, { DL, external }) {
    const csv = typeof payload?.csv === 'string' ? payload.csv : ''
    if (!csv.trim()) throw { status: 400, message: 'missing csv' }
    if (csv.length > MAX_CSV_CHARS)
        throw { status: 400, message: `csv too large (max ${MAX_CSV_CHARS} characters)` }
    if (typeof external?.comax?.getItemById !== 'function')
        throw { status: 500, message: 'comax client is not available' }
    // Without the delivery price list the rows would arrive with no buying
    // price, which the status ladder reads as archived. Better to say so up
    // front than to seed the catalog with rows the sync will hide forever.
    if (!process.env.COMAX_DELIVERY_PRICELIST_ID)
        throw { status: 500, message: 'COMAX_DELIVERY_PRICELIST_ID is not configured' }

    const dryRun = payload.dryRun !== false
    const limit = payload.limit == null
        ? DEFAULT_LIMIT
        : Math.max(0, Number(payload.limit) || 0)
    const requested = Number(payload.concurrency) || Number(process.env.COMAX_BACKFILL_CONCURRENCY) || DEFAULT_CONCURRENCY
    const concurrency = Math.max(1, Math.min(requested, MAX_CONCURRENCY))
    const withGs1 = payload.gs1 === true && !dryRun

    const { codes, invalid, rows } = parseCatalogCsv(csv)
    if (!codes.length) throw { status: 400, message: `csv has no Comax item codes (${CSV_HEADER})` }

    const known = await readKnownCodes(DL)
    const targets = codes.filter(code => !known.has(normalizeCode(code)))

    const startedAt = new Date()
    const report = {
        dryRun,
        csvRows: rows,
        codes: codes.length,
        known: codes.length - targets.length,
        invalid,
        targets: targets.length,
        processed: 0,
        found: 0,
        inserted: 0,
        refreshed: 0,
        existing: 0,
        skipped: { notFound: 0, noBarcode: 0, idMismatch: 0, duplicateBarcode: 0 },
        // Written rows Comax reports as archived (seasonal). Stored and flagged,
        // never live while the flag is set.
        archived: 0,
        // Found only when the price-list filter was lifted: real Comax items with
        // no entry in 1069/255. They get a row so the report can show them.
        noPriceList: 0,
        withBuyingPrice: 0,
        zeroPrice: 0,
        errors: [],
        errorCount: 0
    }

    console.log(`[Comax Backfill] ${codes.length} code(s) in csv, ${report.known} already in comax_products, ${targets.length} to read${dryRun ? ' (dry-run)' : ''}`)
    if (dryRun || !targets.length)
        return { ...report, remaining: 0 }

    const batch = limit > 0 ? targets.slice(0, limit) : targets
    const salesPriceArray = buildSalesPriceArray()
    const trailingCache = new Map()

    // The deposit (TrailingItem) lives in super-department 12, which catalog
    // reads exclude, so it is looked up on demand — a handful of ids per run.
    // Same rule as the import: a failed lookup leaves the item at its own price
    // instead of inventing a deposit. The cache holds the in-flight promise, so
    // two items that share a deposit (concurrent lookups) read it once.
    const resolveTrailingItem = async product => {
        if (!product.trailingItemId) return
        if (!trailingCache.has(product.trailingItemId)) {
            trailingCache.set(product.trailingItemId,
                external.comax.getItemById({ itemId: product.trailingItemId, silent: true, skipLog: true })
                    .catch(e => {
                        log.warn(`[Comax Backfill] trailing item ${product.trailingItemId} could not be read:`, e?.message || e)
                        return null
                    }))
        }
        const trailing = await trailingCache.get(product.trailingItemId)
        if (!trailing) return
        const price = Number(trailing.price) || 0
        product.trailingItemPrice = price
        product.trailingPrice = round2(price * (Number(product.trailingItemQuantity) || 1))
        if (product.price > 0) product.priceWithTrailing = round2(product.price + product.trailingPrice)
    }

    // One item by its Comax id. WithOutArchive=0 on purpose: archived items are
    // seasonal stock we want on file before they return, not items to hide.
    // SelByPriceList + SalesPriceArray bring the buying price (255) in the same
    // call, includeZeroPrice keeps a zero-priced item readable instead of letting
    // it look "not found", and skipLog keeps a run of thousands of lookups from
    // writing a Log document each.
    const readItem = (code, { byPriceList = true } = {}) => external.comax.getItemById({
        itemId: code,
        includeInternal: false,
        includeZeroPrice: true,
        withOutArchive: false,
        ...(byPriceList ? { selByPriceList: true, salesPriceArray } : {}),
        silent: true,
        skipLog: true,
        timeoutMs: COMAX_TIMEOUT_MS
    })

    // Preflight: with Comax unreachable every one of these lookups fails the
    // same way, so one failed probe stops the run before it grinds through the
    // whole list and buries the real reason under thousands of retries.
    try {
        await readItem(batch[0])
    } catch (e) {
        const message = e?.message || String(e)
        log.error('[Comax Backfill] preflight lookup failed:', message)
        throw { status: 502, message: `Comax unreachable: ${message}` }
    }

    let pending = []
    let pendingBarcodes = new Set()
    let done = 0

    // Which of these barcodes are already rows, and which of those a previous
    // backfill created. A row a backfill created is REFRESHED: it is in no store
    // feed, so nothing else would ever update its price or buying price, and a
    // second run would leave it stale forever. A row the import owns is never
    // touched — its price comes from the store feeds and its storeIds from the
    // stock logic.
    const writeChunk = async part => {
        const rows = await DL.ComaxProduct.read(
            { barcode: { $in: part.map(doc => doc.barcode) } },
            { _id: 0, barcode: 1, backfilledAt: 1 },
            { limit: 0 }
        )
        const backfilled = new Set((rows || [])
            .filter(row => row?.backfilledAt)
            .map(row => normalizeCode(row.barcode)))

        const res = await DL.ComaxProduct.bulkWrite({
            docs: part,
            getFilter: doc => ({ barcode: doc.barcode }),
            getUpsert: () => true,
            getUpdate: doc => backfilled.has(normalizeCode(doc.barcode))
                // Refresh: the Comax fields only. storeIds stays out of it (the
                // import owns stock) and so does backfilledAt (it records when
                // the row was created, not when it was last read).
                ? { $set: Object.fromEntries(Object.entries(doc).filter(([key]) => key !== 'storeIds' && key !== 'backfilledAt')) }
                : { $setOnInsert: doc }
        })

        report.inserted += res?.upsertedCount || 0
        report.refreshed += res?.modifiedCount || 0
        report.existing += (res?.matchedCount || 0) - (res?.modifiedCount || 0)
    }

    const flush = async () => {
        if (!pending.length) return
        const docs = pending
        pending = []
        for (const part of chunk(docs, WRITE_CHUNK)) {
            try {
                await writeChunk(part)
            } catch (e) {
                report.errorCount += part.length
                if (report.errors.length < SAMPLE_CAP)
                    report.errors.push({ code: part[0]?.comaxId, message: e?.message || String(e) })
                log.error('[Comax Backfill] batch failed:', e?.message || e)
            }
        }
    }

    const limitConcurrency = pLimit(Math.min(concurrency, batch.length))

    await Promise.all(batch.map(code => limitConcurrency(async () => {
        let product = null
        for (let attempt = 1; attempt <= COMAX_RETRIES && !product; attempt++) {
            try {
                product = await readItem(code)
            } catch (e) {
                if (attempt === COMAX_RETRIES) {
                    report.errorCount++
                    if (report.errors.length < SAMPLE_CAP)
                        report.errors.push({ code, message: e?.message || String(e) })
                    log.warn(`[Comax Backfill] ${code} failed:`, e?.message || e)
                }
            }
        }

        // An empty answer to a price-list query is Comax saying "this item has no
        // entry in 1069 or 255", not "no such item". The butcher scale codes
        // (43001 בקר טחון מחפוד, 43209 צלעות מחפוד and their block) are that case:
        // the item exists, showInWeb is on, it just has no price in either list.
        // Ask once more without the filter: those items get a row, which is the
        // only way they can appear in the report as something to fix.
        const inPriceList = product != null
        if (!product) {
            try {
                product = await readItem(code, { byPriceList: false })
            } catch (e) {
                log.warn(`[Comax Backfill] ${code} price-list-free lookup failed:`, e?.message || e)
            }
        }

        report.processed++
        done++

        if (!product) {
            report.skipped.notFound++
        } else if (normalizeCode(product.comaxId) !== normalizeCode(code)) {
            // The search matched something other than the requested id — writing
            // it would attach unknown data to a catalog row.
            report.skipped.idMismatch++
            if (report.errors.length < SAMPLE_CAP)
                report.errors.push({ code, message: `Comax returned item ${product.comaxId}` })
        } else if (!String(product.barcode ?? '').trim()) {
            report.skipped.noBarcode++
        } else {
            await resolveTrailingItem(product)
            const row = buildBackfilledRow(product, { startedAt })
            const key = normalizeCode(row.barcode)
            // Two Comax items can share a barcode; the unique index keeps one
            // row, so the first one in the file wins.
            if (pendingBarcodes.has(key)) {
                report.skipped.duplicateBarcode++
            } else {
                pendingBarcodes.add(key)
                pending.push(row)
                report.found++
                if (row.archived) report.archived++
                if (!inPriceList) report.noPriceList++
                if (row.buyingPrice > 0) report.withBuyingPrice++
                if (!(row.price > 0)) report.zeroPrice++
            }
        }

        if (pending.length >= WRITE_CHUNK) await flush()
        if (done % 250 === 0)
            console.log(`[Comax Backfill] ${done}/${batch.length} (found ${report.found}, errors ${report.errorCount})`)
    })))

    await flush()

    if (withGs1 && pendingBarcodes.size) {
        try {
            report.gs1 = await queueGs1Lookups({ DL, barcodes: pendingBarcodes, startedAt })
        } catch (e) {
            report.gs1 = { enqueued: 0, error: e?.message || String(e) }
            log.error('[Comax Backfill] GS1 enqueue failed:', e?.message || e)
        }
    }

    const remaining = Math.max(0, targets.length - report.processed)
    console.log(`[Comax Backfill] done: ${report.processed}/${targets.length}, inserted ${report.inserted}, ` +
        `refreshed ${report.refreshed}, left as-is ${report.existing}, with buying price ${report.withBuyingPrice}, zero price ${report.zeroPrice}, ` +
        `no price list ${report.noPriceList}, archived ${report.archived}, ` +
        `skipped ${JSON.stringify(report.skipped)}, errors ${report.errorCount}, remaining ${remaining}` +
        `${report.gs1 ? `, gs1 queued ${report.gs1.enqueued}` : ''}`)

    return { ...report, remaining }
}

backfillCatalog.config = {
    required: ['csv'],
    permissions: ['comax_product:update'],
    auth: 'required',
    preventMultiple: true
}
