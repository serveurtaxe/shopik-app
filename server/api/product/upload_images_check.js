import { planUploadFiles, barcodeFromFileName, MAX_FILES } from '#server/services/image/uploadBulk.js'

/**
 * טעינת תמונות — step 1: what would these file names do?
 *
 * The client sends names and byte counts only (never the image bytes), so the
 * admin sees mistyped barcodes, duplicate barcodes carrying two extensions,
 * and which products will lose their GS1 alternates BEFORE a single file is
 * uploaded. Same two-step shape as product/load_kashrut.
 *
 * POST /api/product/upload_images_check { selection: [{ name, bytes }] }
 */

const READ_CHUNK = 500

export default async function upload_images_check(payload, { DL }) {
    // NOT `files`: common/functions/apiReq.js treats a `files` key as a
    // multipart upload and rewrites the whole body as FormData, which no route
    // here can read (server/index.js has no multer/busboy, so req.files is
    // always empty and the body arrives as {}).
    const picked = Array.isArray(payload?.selection) ? payload.selection : []
    if (!picked.length) throw { status: 400, message: 'no files selected' }
    if (picked.length > MAX_FILES)
        throw { status: 400, message: `too many files (max ${MAX_FILES})` }

    const barcodes = [...new Set(picked.map(file => barcodeFromFileName(file?.name)).filter(Boolean))]

    const products = []
    for (let i = 0; i < barcodes.length; i += READ_CHUNK) {
        const chunk = barcodes.slice(i, i + READ_CHUNK)
        // A scan alias has no doc of its own: the file name may carry the alias
        // barcode (the sheet's image column does), and the image belongs to the
        // product that owns it.
        const found = await DL.Product.read(
            { $or: [{ barcode: { $in: chunk } }, { scannableBarcodes: { $in: chunk } }] },
            { _id: 0, barcode: 1, scannableBarcodes: 1, id: 1, name: 1, images: 1 },
            { limit: 0 }
        )
        products.push(...(found || []))
    }

    return planUploadFiles(picked, products)
}

upload_images_check.config = {
    required: ['selection'],
    permissions: ['product:update'],
    preventMultiple: true
}
