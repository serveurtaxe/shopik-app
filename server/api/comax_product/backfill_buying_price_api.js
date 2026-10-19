import pLimit from 'p-limit'
import log from '#server/utils/log.js'

const DEFAULT_CONCURRENCY = 30
const DEFAULT_BATCH = 500
const RETRIES = 3

export function buildBackfillFilter() {
    return {
        comaxId: { $nin: ['', null] },
        barcode: { $nin: ['', null] },
        $or: [
            { buyingPrice: { $exists: false } },
            { buyingPrice: null },
            { buyingPrice: { $lte: 0 } }
        ]
    }
}

// The search endpoint matches ItemID against the Comax item ID (comaxId), so
// prefer that match; fall back to the only returned item when the IDs differ.
export function pickBuyingPrice(products, comaxId) {
    if (!products?.length) return null
    const match = products.find(p => String(p.comaxId) === String(comaxId)) || products[0]
    const price = Number(match?.price)
    return price > 0 ? price : null
}

export default async function backfillComaxBuyingPrices(payload = {}, { DL, external }) {
    const priceListId = process.env.COMAX_DELIVERY_PRICELIST_ID
    if (!priceListId)
        throw { status: 500, message: 'COMAX_DELIVERY_PRICELIST_ID is not configured' }

    const limit = Number(payload.limit) || 0
    const sample = Number(payload.sample) || 0
    const concurrency = Number(payload.concurrency) || Number(process.env.COMAX_BACKFILL_CONCURRENCY) || DEFAULT_CONCURRENCY
    const batchSize = Number(process.env.COMAX_BACKFILL_BATCH) || DEFAULT_BATCH
    const dryRun = !!payload.dryRun

    const filter = buildBackfillFilter()
    const select = { _id: 0, comaxId: 1, barcode: 1 }

    const total = await DL.ComaxProduct.count(filter)
    if (!total) {
        console.log('[Comax Buying Price Backfill] Nothing to backfill')
        return { targeted: 0, priced: 0, noPrice: 0, errors: 0 }
    }

    // Only comaxId+barcode are loaded (~tens of KB), so the full target list is safe.
    // sample is for small validation runs; the full job processes every target.
    const targets = sample > 0
        ? await DL.ComaxProduct.Model.aggregate([
            { $match: filter },
            { $sample: { size: sample } },
            { $project: select }
        ])
        : await DL.ComaxProduct.read(filter, select, {
            limit: limit > 0 ? limit : 0,
            sort: { _id: 1 }
        })
    console.log(`[Comax Buying Price Backfill] ${targets.length} targets (of ${total}), concurrency ${concurrency}${dryRun ? ', dry-run' : ''}`)

    let priced = 0
    let noPrice = 0
    let errors = 0
    let done = 0
    let pending = []

    async function flush() {
        if (!pending.length) return
        const batch = pending
        pending = []
        if (dryRun) return
        await DL.ComaxProduct.bulkWrite({
            docs: batch,
            getUpsert: () => false,
            getFilter: d => ({ barcode: d.barcode }),
            getUpdate: d => ({ $set: { buyingPrice: d.buyingPrice } })
        })
    }

    async function fetchPrice(comaxId) {
        const products = await external.comax.getProducts({
            priceListId,
            itemId: String(comaxId),
            includeZeroPrice: true,
            skipLog: true,
            silent: true,
            timeoutMs: 20000
        })
        return pickBuyingPrice(products, comaxId)
    }

    const limitConcurrency = pLimit(Math.min(concurrency, targets.length))

    await Promise.all(targets.map(target => limitConcurrency(async () => {
        for (let attempt = 1; attempt <= RETRIES; attempt++) {
            try {
                const price = await fetchPrice(target.comaxId)
                if (price != null) {
                    priced++
                    pending.push({ barcode: target.barcode, buyingPrice: price })
                } else {
                    noPrice++
                }
                break
            } catch (e) {
                if (attempt === RETRIES) {
                    errors++
                    log.warn(`[Comax Buying Price Backfill] ${target.comaxId} failed: ${e?.message || e}`)
                }
            }
        }

        done++
        if (pending.length >= batchSize) await flush()
        if (done % 500 === 0)
            console.log(`[Comax Buying Price Backfill] ${done}/${targets.length} (priced ${priced}, no price ${noPrice}, errors ${errors})`)
    })))

    await flush()

    console.log(`[Comax Buying Price Backfill] Done: ${targets.length} targeted, ${priced} priced, ${noPrice} no price, ${errors} errors`)
    return { targeted: targets.length, priced, noPrice, errors }
}

backfillComaxBuyingPrices.config = {
    permissions: ['comax_product:update']
}
