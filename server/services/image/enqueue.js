import log from '#server/utils/log.js'
import { enqueueImageJobs } from '#server/queues/imageQueue.js'
import { isMainImageComplete } from './constants.js'
import { outranks } from './sourcePriority.js'

export default async function enqueueChangedImages(DL) {
    // Paged: the picUrl scan + $in:[all barcodes] product read held two full
    // catalog copies at once and OOMed 256MB containers when run after sync.
    const BATCH = Number(process.env.COMAX_SYNC_BATCH || 1000)
    const filter = { active: { $ne: false }, picUrl: { $exists: true, $nin: [null, ''] } }
    const total = await DL.ComaxProduct.Model.countDocuments(filter)
    if (!total) return { scanned: 0, enqueued: 0 }

    let scanned = 0
    let enqueued = 0
    let skippedProtected = 0
    // Keyset on the unique barcode: an unsorted skip/limit has no page order to
    // trust (this runs right after the sync rewrote these rows), so a page can
    // repeat or drop rows. Sorting is what makes the cursor mean anything.
    let afterBarcode = null
    while (true) {
        const comaxProducts = await DL.ComaxProduct.Model.find(
            afterBarcode ? { ...filter, barcode: { $gt: afterBarcode } } : filter,
            { _id: 0, barcode: 1, picUrl: 1 }
        ).sort({ barcode: 1 }).limit(BATCH).lean()
        if (!comaxProducts?.length) break
        scanned += comaxProducts.length

        // Advance before anything can `continue`, or the page repeats forever.
        const lastBarcode = comaxProducts[comaxProducts.length - 1]?.barcode
        if (!lastBarcode) break
        afterBarcode = lastBarcode

        const barcodes = [...new Set(comaxProducts.map(p => p.barcode).filter(Boolean))]
        if (!barcodes.length) continue

        const products = await DL.Product.read(
            { barcode: { $in: barcodes } },
            { _id: 0, id: 1, barcode: 1, images: 1 },
            { limit: 0 }
        )

        const productByBarcode = new Map(products.map(p => [p.barcode, p]))

        const jobs = []
        for (const comax of comaxProducts) {
            const product = productByBarcode.get(comax.barcode)
            if (!product || !comax.picUrl) continue

            const mainImage = (product.images?.product || []).find(img => img?.main)
            // A higher-ranked source is never touched — neither filled nor
            // refreshed. Priority: upload > gs1 > scrape > Comax picUrl.
            if (outranks(mainImage?.sourceUrl, comax.picUrl)) {
                skippedProtected++
                continue
            }
            // Own (Comax/manual) main unchanged and complete → skip;
            // missing, different, or partial (no hash/sizes) → (re)fill.
            if (isMainImageComplete(mainImage, comax.picUrl)) continue

            jobs.push({ productId: product.id, sourceUrl: comax.picUrl })
        }

        if (jobs.length) {
            // Fail-soft: a down Redis reports `skipped` instead of throwing, and
            // these products keep their incomplete main image in MongoDB, so the
            // next sync run queues them again.
            const { enqueued: queued, skipped } = await enqueueImageJobs(jobs)
            enqueued += queued
            if (skipped) log.warn(`[ImageQueue] ${skipped} job(s) deferred until Redis is reachable`)
        }

        if (comaxProducts.length < BATCH) break
    }

    log.info(`[ImageQueue] Enqueued ${enqueued}/${scanned} products with images (skipped ${skippedProtected} protected-source mains)`)

    return { scanned, enqueued }
}