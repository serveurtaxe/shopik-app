import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import apiReq from '#common/functions/apiReq.js'
import checkRoute from '#server/api/product/upload_images_check.js'
import uploadRoute from '#server/api/product/upload_image.js'
import {
    applyProductUpload,
    barcodeFromFileName,
    planUploadFiles,
    uploadConcurrency,
    MAX_FILE_BYTES
} from '#server/services/image/uploadBulk.js'

const image = (sourceUrl, extras = {}) => ({ main: true, sourceUrl, ...extras })
const product = (barcode, images = [], name = '') => ({ barcode, id: `p-${barcode}`, name, images: { product: images } })

describe('bulk image upload naming', () => {
    it('reads the barcode out of <barcode>.<ext>', () => {
        for (const name of ['3528.png', '3528.jpg', '3528.jpeg', '3528.webp', '3528.PNG', ' 3528.png '])
            assert.equal(barcodeFromFileName(name), '3528', name)
    })

    it('rejects every name that is not exactly a barcode', () => {
        for (const name of ['IMG_3528.png', '3528.png.png', '3528.png.jpg', 'mozzarella.png', '3528.tiff', '3528', '', '352 .png', '3528x.png', 'א1234.png'])
            assert.equal(barcodeFromFileName(name), null, name)
    })

    it('rejects barcodes too short or too long to be real', () => {
        assert.equal(barcodeFromFileName('12.png'), null)
        assert.equal(barcodeFromFileName('1'.repeat(15) + '.png'), null)
        assert.equal(barcodeFromFileName('1'.repeat(14) + '.png'), '1'.repeat(14))
    })
})

describe('bulk image upload plan', () => {
    const files = list => list.map(name => ({ name, bytes: 1000 }))

    it('plans the accepted files and reports what each product has today', () => {
        const products = [
            product('3528', [image('gs1://3528')], 'בננה'),
            product('1014', []),
            product('7290012345678', [image('https://comax/pic.jpg'), { sourceUrl: 'gs1://7290012345678/alt' }])
        ]
        const plan = planUploadFiles(files(['3528.png', '1014.jpg', '7290012345678.webp']), products)

        assert.equal(plan.files, 3)
        assert.equal(plan.barcodes, 3)
        assert.equal(plan.matched, 3)
        assert.deepEqual(plan.accepted.map(a => a.barcode), ['3528', '1014', '7290012345678'])
        assert.deepEqual(plan.sources, { gs1: 1, none: 1, comax: 1 })
        assert.equal(plan.unmatched.length, 0)
        assert.equal(plan.invalid.length, 0)
        // The product with a non-main entry is the one the admin must approve losing.
        assert.deepEqual(plan.alternates, [{ barcode: '7290012345678', name: '', count: 1 }])
    })

    it('lists bad names and oversized files as invalid instead of guessing', () => {
        const plan = planUploadFiles([
            { name: 'IMG_123.png', bytes: 10 },
            { name: '1234.png', bytes: MAX_FILE_BYTES + 1 }
        ], [])

        assert.deepEqual(plan.invalid, [
            { name: 'IMG_123.png', reason: 'bad_name' },
            { name: '1234.png', reason: 'too_large' }
        ])
        assert.equal(plan.accepted.length, 0)
        assert.equal(plan.barcodes, 0)
    })

    it('refuses a barcode carried by two files — which one wins is a coin flip', () => {
        const plan = planUploadFiles(files(['3528.png', '3528.jpg', '1014.png']), [product('3528'), product('1014')])

        assert.deepEqual(plan.conflicts, [{ barcode: '3528', names: ['3528.png', '3528.jpg'] }])
        assert.deepEqual(plan.accepted.map(a => a.name), ['1014.png'])
        assert.equal(plan.barcodes, 1)
    })

    it('reports barcodes with no product', () => {
        const plan = planUploadFiles(files(['3528.png', '9999999999999.png']), [product('3528')])

        assert.deepEqual(plan.unmatched, [{ name: '9999999999999.png', barcode: '9999999999999' }])
        assert.equal(plan.matched, 1)
    })

    it('matches a file named after a scan alias to the product that owns it', () => {
        // The sheet's image column names the alias barcode, not the main one.
        const owner = { ...product('3528'), scannableBarcodes: ['7290001201824'] }
        const plan = planUploadFiles(files(['7290001201824.png']), [owner])

        assert.deepEqual(plan.unmatched, [])
        assert.deepEqual(plan.accepted, [{ name: '7290001201824.png', barcode: '7290001201824' }])
        assert.equal(plan.matched, 1)
    })

    it('tells the client how many uploads the server will hold at once', () => {
        const plan = planUploadFiles(files(['3528.png']), [product('3528')])

        assert.ok(Number.isInteger(uploadConcurrency()))
        assert.ok(uploadConcurrency() >= 1)
        assert.equal(plan.concurrency, uploadConcurrency())
    })

    it('counts an already-uploaded main as an upload, not as a new product', () => {
        const plan = planUploadFiles(files(['3528.png']), [product('3528', [image('upload://3528', { hash: 'x' })])])

        assert.deepEqual(plan.sources, { upload: 1 })
    })
})

// The paths that need no bucket and no sharp: a file is rejected before the
// server spends any memory on it.
describe('bulk image upload rejects', () => {
    const DL = products => ({
        Product: {
            readOne: async ({ barcode }) => products.find(p => p.barcode === barcode) || null,
            update: async () => ({ matchedCount: 1 })
        }
    })

    it('refuses a name that is not a barcode before reading anything', async () => {
        await assert.rejects(
            async () => await applyProductUpload({ DL: DL([]), name: 'banana.png', fileBase64: 'AAA=' }),
            e => e.status === 400 && /barcode/.test(e.message)
        )
    })

    it('refuses a missing file', async () => {
        await assert.rejects(
            async () => await applyProductUpload({ DL: DL([]), name: '3528.png' }),
            e => e.status === 400
        )
    })

    it('refuses a barcode with no product', async () => {
        await assert.rejects(
            async () => await applyProductUpload({ DL: DL([]), name: '9999999999999.png', fileBase64: 'AAA=' }),
            e => e.status === 404 && /9999999999999/.test(e.message)
        )
    })
})

// The client/server contract, because it is the part that silently breaks:
// common/functions/apiReq.js rewrites ANY body carrying a `files` key into a
// multipart form, and no route here can read multipart (server/index.js parses
// json/urlencoded only), so the check pass used to arrive as an empty body.
describe('bulk image upload route contract', () => {
    it('never asks for the reserved `files` key', () => {
        assert.ok(!checkRoute.config.required.includes('files'))
        assert.ok(!uploadRoute.config.required.includes('files'))
    })

    it('sends the selection as JSON', async () => {
        globalThis.APP_VERSION = 'test'
        const realFetch = globalThis.fetch
        let sent
        globalThis.fetch = async (url, opts) => {
            sent = { contentType: opts.headers?.['Content-Type'], body: opts.body }
            return { ok: true, status: 200, json: async () => ({ status: 200, data: { accepted: [] } }) }
        }
        try {
            await apiReq('product/upload_images_check', { selection: [{ name: '3528.png', bytes: 12 }] })
        } finally {
            globalThis.fetch = realFetch
        }

        assert.equal(sent.contentType, 'application/json')
        assert.ok(!(sent.body instanceof FormData))
        assert.deepEqual(JSON.parse(sent.body).selection, [{ name: '3528.png', bytes: 12 }])
    })

    it('plans a selection end to end', async () => {
        const DL = {
            Product: {
                read: async () => [{ barcode: '3528', id: 'p1', name: 'בננה', images: { product: [{ main: true, sourceUrl: 'gs1://3528' }] } }]
            }
        }
        const report = await checkRoute(
            { selection: [{ name: '3528.png', bytes: 40 }, { name: 'nope.png', bytes: 40 }] },
            { DL }
        )

        assert.deepEqual(report.accepted, [{ name: '3528.png', barcode: '3528' }])
        assert.deepEqual(report.invalid, [{ name: 'nope.png', reason: 'bad_name' }])
    })
})
