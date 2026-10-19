import { createHash } from 'crypto'
import resize from '../resize.js'
import upload from '../upload.js'
import download from '../download.js'
import { findCandidate } from './providers.js'
import log from '#server/utils/log.js'

const hashUrl = url => createHash('sha1').update(url).digest('hex')

// Priority: GS1 > scrape > Comax. Never touches GS1 mains; Comax picUrl
// jobs are blocked from overwriting scrape mains (see enqueue.js +
// imageWorker.js guards), so this is the only writer of scrape:// entries.
export default async function scrapeProductImage({ DL, barcode, force = false, dryRun = false, order = null }) {
    if (!barcode) throw new Error('barcode required')
    const product = await DL.Product.readOne(
        { barcode },
        { _id: 0, id: 1, barcode: 1, name: 1, images: 1, status: 1 }
    )
    if (!product) return { barcode, skipped: 'no-product' }

    const main = (product.images?.product || []).find(img => img?.main)
    if (main?.sourceUrl?.startsWith('gs1://'))
        return { barcode, skipped: 'gs1-present' }
    // Imageless-only: never replace an existing image (any source).
    // --force explicitly overrides (re-scrape / provider change).
    if ((product.images?.product || []).length > 0 && !force)
        return { barcode, skipped: 'has-images' }

    const { candidate, tried } = await findCandidate(barcode, { name: product.name, ...(order ? { order } : {}) })
    if (!candidate) {
        // Park as tried so bulk sweeps don't re-probe misses every chunk.
        // (429-unknowns mostly resolve via in-run retry; stragglers return
        // via --retry-failed.)
        await DL.Product.update({ id: product.id }, { scrapeTriedAt: new Date() }).catch(() => null)
        return { barcode, skipped: 'no-candidate', tried: tried.length }
    }
    if (dryRun) return { barcode, dryRun: true, candidate }

    const sourceRef = `scrape://${candidate.site}/${barcode}`
    const candidateHash = hashUrl(candidate.sourceUrl)
    // Same provider + same upstream bytes + complete previous write → skip.
    // (Unlike Comax picUrl jobs, the provider identity is part of the ref, so
    // a provider change always reprocesses.)
    if (!force && main?.sourceUrl === sourceRef && main?.hash === candidateHash &&
        Object.keys(main?.sizes || {}).length)
        return { barcode, skipped: 'unchanged' }

    // Prefer the bytes findCandidate already verified: re-downloading here
    // doubles CDN load and can 429 after verification passed (those hits
    // were previously lost as processImage errors). Falls back to a fresh
    // download only when no verified buffer was handed along.
    const source = candidate.buffer || await download(candidate.sourceUrl)
    const sizes = await upload({ productId: product.id, sizes: await resize(source) })
    const update = {
        'images.product': [
            { main: true, sourceUrl: sourceRef, hash: candidateHash, sizes }
        ]
    }
    // Mirror the GS1 first-image rule: imageless HIDDEN flips to ACTIVE.
    // (The next Comax sync re-evaluates status anyway and keeps it in sync.)
    if ((product.images?.product || []).length === 0 && product.status === 'hidden')
        update.status = 'active'

    await DL.Product.update({ id: product.id }, update)
    log.success(`[Scrape] Done: ${product.id} (${barcode}) via ${candidate.site}`)
    return { barcode, ok: true, site: candidate.site, width: candidate.width, height: candidate.height }
}
