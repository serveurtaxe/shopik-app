/**
 * Backfill product images from Israeli retail/manufacturer sites.
 * Provider priority: Rami Levy → Yochananof → Super-Pharm → Self-Point
 * (allcomplete/mehadrin/tivtaam) → Osem-Nestle (see
 * server/services/image/scrape/providers.js). Only the main image, only
 * sources with width>=500 or height>=500 (verified with sharp, no upscales).
 * Verified bytes are cached on disk by barcode (data/scrape-cache, gitignored)
 * so follow-up runs never re-scrape: a disk hit short-circuits providers.
 *
 * Priority: GS1 > scrape > Comax. GS1 mains are never touched; Comax picUrl
 * jobs cannot overwrite scrape mains (enqueue + imageWorker guards).
 * Imageless-only: products that already have any image are skipped
 * (--force overrides). First image on an imageless HIDDEN product flips it
 * to ACTIVE (same rule as the GS1 process worker; Comax sync re-evaluates
 * status regardless).
 * --comax: different selection — replaces products whose current main image
 * is a Comax upload (sourceUrl matches www.comax.co.il/Max2000Upload) with a
 * scraped image when a >=500px candidate exists. Implies --force; the Comax
 * image is only overwritten on a hit, so misses keep their existing image.
 *
 * Usage: node server/scripts/runScrapeProductImages.js --barcode 7290000066318 [--dry-run] [--force] [--providers rami-levy,super-pharm]
 *        node server/scripts/runScrapeProductImages.js --imageless [--limit N] [--dry-run] [--force] [--concurrency N] [--providers rami-levy,super-pharm] [--delay-ms 1200] [--retry-failed]
 *        node server/scripts/runScrapeProductImages.js --comax [--limit N] [--dry-run] [--concurrency N] [--providers ...] [--delay-ms 1200] [--retry-failed]
 *        node server/scripts/runScrapeProductImages.js --folder "C:\path\to\imgs" [--limit N] [--dry-run] [--concurrency N]
 *                                                     folder mode: local files <barcode>.{jpg,jpeg,webp,png} are the only
 *                                                     source; min-size gate + provenance via seedFromFolder; a final
 *                                                     report lists folder-covered products still imageless.
 */
import scrapeProductImage from '#server/services/image/scrape/scrapeProduct.js'
import { PROVIDER_ORDER, seedFromFolder } from '#server/services/image/scrape/providers.js'

export default async function scrapeProductImages(
    { DL } = {},
    { barcode = '', imageless = false, comax = false, limit = 0, force = false, dryRun = false, concurrency = 3, providers = '', delayMs = 0, retryFailed = false, nameMatch = '', folder = '' } = {}
) {
    if (!DL) throw new Error('DL required')
    let barcodes = []
    let folderReport = null
    if (folder) {
        // Folder mode (--folder): verified local files (see seedFromFolder)
        // are the ONLY source for this run — no CDN probing. scrapeTriedAt
        // parking is ignored (a local file is new evidence); scrapeProduct
        // still skips gs1-present / has-images products.
        const { matched, rejected, ignored } = await seedFromFolder(folder)
        console.log(`[scrape] folder: ${matched.size} usable, ${rejected.length} rejected, ${ignored} ignored files`)
        for (const r of rejected)
            console.log(`[scrape] folder rejected: ${r.file} → ${r.barcode}: ${r.reason}${r.width ? ` ${r.width}x${r.height}` : ''}${r.error ? ` (${r.error})` : ''}`)
        if (!matched.size) {
            console.log('[scrape] done: 0 ok (nothing usable in folder)')
            return { ok: 0, skipped: { 'folder-rejected': rejected.length, 'folder-ignored': ignored } }
        }
        // Raw Model: processFilter strips $and/$size/non-whitelisted fields,
        // so DL.Product.read can't express this (same bypass as order/ops/list).
        const docs = await DL.Product.Model.find(
            {
                $and: [
                    { $or: [{ images: { $exists: false } }, { 'images.product': { $size: 0 } }] },
                    { barcode: { $in: [...matched.keys()] } }
                ]
            },
            { _id: 0, barcode: 1 }
        ).limit(Number(limit) || 0).lean()
        barcodes = [...new Set((docs || []).map(p => p?.barcode).filter(Boolean))]
        console.log(`[scrape] folder: ${barcodes.length} imageless products matched`)
        // Snapshot before the workers consume the array (nextJob splices).
        folderReport = { rejected, processed: barcodes.slice() }
    } else if (barcode) {
        barcodes = [String(barcode)]
    } else if (comax) {
        // Replace Comax uploads with a scraped main. Implies force (a Comax
        // image normally counts as "has-images"); the existing image stays
        // untouched unless a >=MIN_SIDE candidate is actually found.
        // Misses are parked like imageless runs, so sweeps progress; pass
        // --retry-failed to re-probe them.
        // Active products only: inactive ones aren't shoppable and their
        // images aren't worth bandwidth.
        force = true
        const docs = await DL.Product.Model.find(
            {
                $and: [
                    { 'images.product.sourceUrl': /www\.comax\.co\.il\/Max2000Upload/ },
                    { status: 'active' },
                    { barcode: { $regex: '^[0-9]{8,14}$' } },
                    ...(retryFailed ? [] : [{ scrapeTriedAt: { $exists: false } }]),
                    ...(nameMatch ? [{ name: { $regex: nameMatch } }] : [])
                ]
            },
            { _id: 0, barcode: 1 }
        ).limit(Number(limit) || 0).lean()
        barcodes = [...new Set((docs || []).map(p => p?.barcode).filter(Boolean))]
    } else if (imageless) {
        // Raw Model: processFilter strips $and/$size/non-whitelisted fields,
        // so DL.Product.read can't express this (same bypass as order/ops/list).
        // GTIN-shaped barcodes only: short PLU/weighable codes ('5', '42')
        // never match barcode-keyed provider URLs.
        const docs = await DL.Product.Model.find(
            {
                $and: [
                    { $or: [{ images: { $exists: false } }, { 'images.product': { $size: 0 } }] },
                    { barcode: { $regex: '^[0-9]{8,14}$' } },
                    // Skip already-probed misses (parked with scrapeTriedAt)
                    // unless explicitly retrying them.
                    ...(retryFailed ? [] : [{ scrapeTriedAt: { $exists: false } }]),
                    // Optional name pre-filter (e.g. manufacturer-brand sweep
                    // for providers that only carry own brands).
                    ...(nameMatch ? [{ name: { $regex: nameMatch } }] : [])
                ]
            },
            { _id: 0, barcode: 1 }
        ).limit(Number(limit) || 0).lean()
        barcodes = [...new Set((docs || []).map(p => p?.barcode).filter(Boolean))]
    } else {
        throw new Error('pass --barcode <bc>, --folder <dir>, --comax, or --imageless [--limit N]')
    }

    console.log(`[scrape] ${barcodes.length} barcodes${dryRun ? ' (DRY RUN)' : ''}${force ? ' (force)' : ''}`)
    const order = String(providers || '')
        .split(',')
        .map(s => s.trim())
        .filter(s => PROVIDER_ORDER.includes(s))
    const orderOpt = order.length ? { order } : {}
    if (order.length) console.log(`[scrape] providers: ${order.join(' → ')}`)
    const totals = { ok: 0, skipped: {} }
    const workers = Math.max(1, Number(concurrency) || 3)
    const delay = Math.max(0, Number(delayMs) || 0)
    const nextJob = () => barcodes.splice(0, 1)[0]
    async function worker() {
        for (;;) {
            const bc = nextJob()
            if (!bc) return
            if (delay) await new Promise(r => setTimeout(r, delay))
            try {
                const res = await scrapeProductImage({ DL, barcode: bc, force, dryRun, ...orderOpt })
                if (res.ok || res.dryRun) {
                    totals.ok++
                    console.log(`[scrape] ${bc} ← ${res.site || res.candidate?.site} ${res.width || res.candidate?.width}x${res.height || res.candidate?.height}${dryRun ? ' (dry)' : ''}`)
                } else {
                    totals.skipped[res.skipped] = (totals.skipped[res.skipped] || 0) + 1
                    console.log(`[scrape] ${bc} skipped: ${res.skipped}`)
                }
            } catch (e) {
                totals.skipped[`error:${e?.message || e}`.slice(0, 80)] =
                    (totals.skipped[`error:${e?.message || e}`.slice(0, 80)] || 0) + 1
                console.log(`[scrape] ${bc} ERROR: ${e?.message || e}`)
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(workers, barcodes.length || 1) }, worker))

    // Folder mode: close the loop — which folder-covered products remain
    // imageless after the run (rejected files, run errors, limit cutoff)?
    if (folderReport) {
        const covered = [...folderReport.processed, ...folderReport.rejected.map(r => r.barcode)]
        const docs = await DL.Product.Model.find(
            {
                $and: [
                    { $or: [{ images: { $exists: false } }, { 'images.product': { $size: 0 } }] },
                    { barcode: { $in: covered } }
                ]
            },
            { _id: 0, barcode: 1 }
        ).lean()
        const reasonFor = new Map(folderReport.rejected.map(r => [r.barcode, `file rejected: ${r.reason}`]))
        const still = [...new Set((docs || []).map(d => d.barcode))]
        console.log(`[scrape] folder report: ${still.length} folder products still imageless${dryRun ? ' (dry run — nothing was written)' : ''}:`)
        for (const bc of still)
            console.log(`  ${bc}: ${reasonFor.get(bc) || (dryRun ? 'dry run — not processed' : 'error during run (see logs above)')}`)
    }

    console.log(`[scrape] done: ${totals.ok} ok, skipped=${JSON.stringify(totals.skipped)}`)
    return totals
}
