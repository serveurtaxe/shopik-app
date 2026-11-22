import path from 'path'
import sharp from 'sharp'
import pLimit from 'p-limit'
import { createHash } from 'crypto'
import storage from '#server/external/storage.js'
import log from '#server/utils/log.js'
import resize from './resize.js'
import upload from './upload.js'
import { SOURCE_UPLOAD, sourceLabel } from './sourcePriority.js'

/**
 * Bulk product-image upload (טעינת תמונות).
 *
 * The file NAME is the lookup: `<barcode>.png` — nothing else maps a file to a
 * product, so anything the pattern rejects is reported instead of guessed at.
 * The client only ever sends names for the check pass and one file at a time
 * for the write, which keeps the server out of multi-hundred-megabyte payloads.
 *
 * The write replaces the whole `images.product` array with a single
 * `upload://<barcode>` main: an admin's own photo outranks supplier media
 * (see sourcePriority.js), and alternates that came from GS1 are dropped with
 * it — the check pass reports them first so the admin can back out.
 *
 * Memory contract with the client: ONE file per HTTP request, at most
 * `uploadConcurrency()` requests in flight (the check response carries the
 * number), and the server refuses past that backlog. A lean server must not
 * depend on the client being polite — express has already parsed every
 * in-flight body by the time this code runs.
 */

// Digits only: a stray prefix, space or Hebrew digit fails loudly.
export const NAME_PATTERN = /^(\d{3,14})\.(png|jpe?g|webp)$/i

// base64 inflates ~33%: 8MB raw ≈ 10.7MB on the wire, inside the 15MB JSON
// body limit (server/index.js). Bigger than this is a scanner export, not a
// product photo.
export const MAX_FILE_BYTES = 8 * 1024 * 1024
export const MAX_FILES = 500
// 300px is the 'm' rung — narrower sources would be upscaled by every rung.
export const MIN_WIDTH = 300
// sharp memory guard: 4096 is well past the 1000px 'xl' rung already.
export const MAX_SIDE = 4096
export const IMAGE_FORMATS = ['png', 'jpeg', 'webp']

// How many uploads one browser session may run at once. Three matches the
// other image batches (scripts/reprocessProductImages.js) and keeps a 512MB
// container inside one sharp pipeline per request.
export const uploadConcurrency = () => Math.max(1, Number(process.env.IMAGE_UPLOAD_CONCURRENCY || 3))

/** barcode from `<barcode>.<ext>`, or null when the name is not usable. */
export function barcodeFromFileName(name) {
    const match = NAME_PATTERN.exec(String(name || '').trim())
    return match ? match[1] : null
}

const mainImageOf = product => (product?.images?.product || []).find(img => img?.main)
const alternatesOf = product => (product?.images?.product || []).filter(img => !img?.main).length

/**
 * What a set of file names would do, resolved against the products already
 * read from the DB. Pure — the check endpoint owns the DB read, so the plan is
 * testable and never half-applies anything.
 *
 * @param {{ name: string, bytes: number }[]} files
 * @param {{ barcode: string, name?: string, images?: { product?: object[] } }[]} products
 */
export function planUploadFiles(files = [], products = []) {
    const invalid = []
    const byBarcode = new Map()

    for (const file of files) {
        const name = String(file?.name || '')
        const barcode = barcodeFromFileName(name)
        if (!barcode) {
            invalid.push({ name, reason: 'bad_name' })
            continue
        }
        if (Number(file?.bytes) > MAX_FILE_BYTES) {
            invalid.push({ name, reason: 'too_large' })
            continue
        }
        if (!byBarcode.has(barcode)) byBarcode.set(barcode, [])
        byBarcode.get(barcode).push(name)
    }

    // 3528.png + 3528.jpg in one run: which one wins is a coin flip, so
    // neither is uploaded and the admin fixes the file set instead.
    const conflicts = [...byBarcode]
        .filter(([, names]) => names.length > 1)
        .map(([barcode, names]) => ({ barcode, names }))
    for (const { barcode } of conflicts) byBarcode.delete(barcode)

    const productByBarcode = new Map()
    for (const product of products || []) {
        if (product?.barcode) productByBarcode.set(product.barcode, product)
        // The file may be named after a scan alias; it describes the owner.
        for (const alias of product?.scannableBarcodes || [])
            productByBarcode.set(String(alias), product)
    }
    const unmatched = []
    const accepted = []
    const sources = {}
    const alternates = []

    for (const [barcode, names] of byBarcode) {
        const product = productByBarcode.get(barcode)
        if (!product) {
            unmatched.push({ name: names[0], barcode })
            continue
        }
        for (const name of names) accepted.push({ name, barcode })
        const label = mainImageOf(product)?.sourceUrl ? sourceLabel(mainImageOf(product).sourceUrl) : 'none'
        sources[label] = (sources[label] || 0) + 1
        const count = alternatesOf(product)
        if (count) alternates.push({ barcode, name: product.name || '', count })
    }

    return {
        files: files.length,
        barcodes: byBarcode.size,
        matched: byBarcode.size - unmatched.length,
        invalid,
        conflicts,
        unmatched,
        // What step 2 will actually write — the client uploads exactly these
        // and never re-implements the naming rule to work it out.
        accepted,
        sources,
        alternates,
        concurrency: uploadConcurrency()
    }
}

/**
 * Alternates live under images/products/<id>/alt-N/. Dropping the DB entries
 * orphans those objects, so they are deleted too. Best-effort: a failed
 * cleanup must not report a successful upload as a failure.
 */
async function dropAlternates(productId) {
    const prefix = `${path.posix.join('images', 'products', String(productId))}/`
    try {
        const [files] = await storage.getBucket().getFiles({ prefix })
        const stale = (files || []).filter(file => file.name?.slice(prefix.length).startsWith('alt-'))
        await Promise.all(stale.map(file => file.delete({ ignoreNotFound: true }).catch(() => null)))
        return stale.length
    } catch (e) {
        log.warn(`[UploadImage] Alternate cleanup skipped for ${productId}:`, e?.message || e)
        return 0
    }
}

const readImage = async buffer => {
    try {
        const meta = await sharp(buffer, { animated: false }).metadata()
        if (!meta?.width || !meta?.height) throw new Error('no dimensions')
        return meta
    } catch {
        throw { status: 400, message: 'unreadable image' }
    }
}

// The server's own ceiling on concurrent upload pipelines. One request holds a
// decoded image + four webp rungs at once; the client is told this number and
// never allowed to push past it, no matter how many files it selected.
let limiter
const uploadSlots = () => {
    if (!limiter) limiter = pLimit(uploadConcurrency())
    return limiter
}

/**
 * One uploaded file → one product main image. Runs inline (like
 * display_block/upload_image.js): the image queue downloads a URL, and an
 * upload has none.
 *
 * One file per request, `uploadConcurrency()` of them at a time: the client
 * sends the next file only after a slot frees, so the server never holds a
 * whole batch and never writes a batch to disk.
 */
export function applyProductUpload({ DL, name, fileBase64 }) {
    const barcode = barcodeFromFileName(name)
    if (!barcode)
        throw { status: 400, message: `file name must be <barcode>.png|jpg|jpeg|webp (got ${name || 'nothing'})` }
    if (!fileBase64) throw { status: 400, message: 'fileBase64 required' }

    const slots = uploadSlots()
    // Bounded backlog: express has ALREADY parsed this request's body, so every
    // queued upload is a ~10MB base64 string sitting in memory waiting for a
    // slot. Rejecting past the backlog protects the memory the limit exists for.
    if (slots.pendingCount >= uploadConcurrency())
        throw { status: 429, message: 'too many image uploads in flight — retry in a moment' }

    return slots(() => runUpload({ DL, barcode, fileBase64 }))
}

async function runUpload({ DL, barcode, fileBase64 }) {
    // Post-decode size check only: base64 length is not the byte count.
    const buffer = Buffer.from(String(fileBase64).split(',').pop(), 'base64')
    if (!buffer?.length) throw { status: 400, message: 'empty file' }
    if (buffer.length > MAX_FILE_BYTES)
        throw { status: 400, message: `file too large (max ${MAX_FILE_BYTES / 1024 / 1024}MB)` }

    const select = { _id: 0, id: 1, barcode: 1, name: 1, images: 1, status: 1 }
    let product = await DL.Product.readOne({ barcode }, select)
    // The file may be named after a scan alias; the image belongs to the
    // product that owns that barcode.
    if (!product && DL.Product.Model?.findOne)
        product = await DL.Product.Model.findOne({ scannableBarcodes: barcode }, select).lean()
    if (!product) throw { status: 404, message: `no product with barcode ${barcode}` }

    const meta = await readImage(buffer)
    if (!IMAGE_FORMATS.includes(meta.format))
        throw { status: 400, message: 'image must be a PNG, JPEG or WebP file' }
    if (meta.width < MIN_WIDTH)
        throw { status: 400, message: `image must be at least ${MIN_WIDTH}px wide` }
    if (Math.max(meta.width, meta.height) > MAX_SIDE)
        throw { status: 400, message: `image sides must be at most ${MAX_SIDE}px` }

    // Serial rungs: up to three of these requests run at once, and sharp is
    // already limited to (vCPU - 1) inside the container (services/gs1/sizing.js).
    const sizes = await upload({
        productId: product.id,
        sizes: await resize(buffer, undefined, { serial: true }),
        serial: true
    })

    const previous = mainImageOf(product)
    const update = {
        'images.product': [{
            main: true,
            sourceUrl: `${SOURCE_UPLOAD}${barcode}`,
            // sha1 of the bytes, not the name: the hash is what the client
            // cache-buster (common/functions/productImageUrl.js) appends, so it
            // must change exactly when the picture changes.
            hash: createHash('sha1').update(buffer).digest('hex'),
            sizes
        }]
    }
    // Mirror the GS1/scrape first-image rule: an imageless HIDDEN flips ACTIVE.
    if (!(product.images?.product || []).length && product.status === 'hidden')
        update.status = 'active'

    const res = await DL.Product.update({ id: product.id }, update)
    if (!res?.matchedCount) {
        log.warn(`[UploadImage] Product ${product.id} not updated (barcode ${barcode})`)
        throw { status: 404, message: `product ${product.id} could not be updated` }
    }

    const dropped = await dropAlternates(product.id)
    log.success(`[UploadImage] ${barcode} → ${product.id} ${meta.width}x${meta.height} (replaced ${sourceLabel(previous?.sourceUrl || '')})`)

    return {
        barcode,
        productId: product.id,
        width: meta.width,
        height: meta.height,
        bytes: buffer.length,
        replaced: previous?.sourceUrl ? sourceLabel(previous.sourceUrl) : 'none',
        droppedAlternates: dropped
    }
}

export default { barcodeFromFileName, planUploadFiles, applyProductUpload, uploadConcurrency }
