import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

function itemXml({ id, barcode, name, price, superDepartmentCode, archived }) {
    return `<ClsItems><ID>${id}</ID><Barcode>${barcode}</Barcode><Name>${name}</Name><Price>${price}</Price>` +
        `<SuperDepartmentCode>${superDepartmentCode}</SuperDepartmentCode><SuperDepartment>מחלקה</SuperDepartment>` +
        `<DepartmentCode>3</DepartmentCode><Department>מחלקה</Department>` +
        `<GroupCode>4</GroupCode><Group>קבוצה</Group>` +
        `<ArchiveDate>${archived || ''}</ArchiveDate></ClsItems>`
}

const ITEMS = [
    { id: 1, barcode: '100', name: 'לחם', price: '12.5', superDepartmentCode: '3' },
    { id: 2, barcode: '101', name: 'חלב', price: '6', superDepartmentCode: '3' },
    { id: 3, barcode: '102', name: 'יין', price: '30', superDepartmentCode: '12' },
    { id: 4, barcode: '103', name: 'חינם', price: '0', superDepartmentCode: '3' },
    { id: 5, barcode: '104', name: 'ארכיון', price: '8', superDepartmentCode: '3', archived: '01/01/2024' }
]

function buildDocument(items) {
    const body = items.map(itemXml).join('\n')
    return `<?xml version="1.0" encoding="utf-8"?>\n<ArrayOfClsItems>\n${body}\n</ArrayOfClsItems>\n`
}

const DL = {
    Log: {
        constants: { DIRECTION: { OUT: 'out' }, ACTOR: { API: 'api' } },
        start: () => ({ actor: () => { }, success: async () => { }, error: async () => { } })
    }
}

let server
let url
let comax

before(async () => {
    server = http.createServer(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/xml; charset=utf-8' })
        const doc = buildDocument(ITEMS)
        // Write the body in small pieces so the client really has to stitch
        // blocks back together across chunk boundaries.
        for (let i = 0; i < doc.length; i += 37) {
            res.write(doc.slice(i, i + 37))
            await new Promise(r => setTimeout(r, 0))
        }
        res.end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}/Get_AllItemsDetailsBySearch`

    process.env.COMAX_PRODUCTS_URL = url
    const { default: createComax } = await import('../../server/external/comax/index.js')
    comax = createComax({ DL })
})

after(async () => {
    await new Promise(resolve => server.close(resolve))
})

describe('comax product streaming', () => {
    it('maps the streamed items and applies the catalog filters', async () => {
        const products = []
        const stats = {}
        for await (const product of comax.streamProducts({ stats })) {
            products.push(product)
        }

        // super-department 12 is excluded, and so is the zero-price item.
        // (fast-xml-parser turns numeric codes and barcodes into numbers —
        // same as the whole-document parse it replaces.)
        assert.deepEqual(products.map(p => String(p.barcode)), ['100', '101', '104'])
        assert.equal(products[0].name, 'לחם')
        assert.equal(products[0].price, 12.5)
        assert.equal(products[0].superDepartmentCode, 3)
        assert.equal(products[0].archived, false)
        assert.equal(products[2].archived, true)
        assert.equal(stats.blocks, 5)
        assert.equal(stats.unparsed, 0)
    })

    it('keeps zero-price items when they are asked for', async () => {
        const products = []
        for await (const product of comax.streamProducts({ includeZeroPrice: true })) {
            products.push(product)
        }

        // super-department 12 stays excluded either way.
        assert.deepEqual(products.map(p => String(p.barcode)), ['100', '101', '103', '104'])
    })
})
