import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

// The store/department feeds build their price-list array from these, so the
// request assertions below do not depend on what the machine happens to have set.
process.env.COMAX_PRICELIST_ID = '1069'
process.env.COMAX_DELIVERY_PRICELIST_ID = '255'

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
let requests

before(async () => {
    requests = []
    server = http.createServer(async (req, res) => {
        requests.push(req.url)
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

    it('asks the catalog feeds for every item, not only the priced-list ones', async () => {
        const collect = async stream => {
            const products = []
            for await (const product of stream) products.push(product)
            return products
        }

        requests.length = 0
        const store = await collect(comax.streamStoreProducts({ storeId: '84' }))
        const fresh = await collect(comax.streamDepartmentProducts({ departmentId: '54', storeId: '84' }))

        for (const request of requests) {
            const params = new URL(request, 'http://127.0.0.1').searchParams
            // SelByPriceList is an item selector: Comax answers nothing at all for
            // an item with no entry in 1069/255. The prices come from
            // SalesPriceArray on its own, which the feeds still send.
            assert.equal(params.has('SelByPriceList'), false)
            assert.equal(params.get('SalesPriceArray'), '1069,255')
            assert.equal(params.get('PriceListID'), '1069')
        }
        assert.equal(new URL(requests[0], 'http://127.0.0.1').searchParams.get('HasInventory'), '1')
        assert.equal(new URL(requests[1], 'http://127.0.0.1').searchParams.has('HasInventory'), false)

        // The zero-price item (103) is the one the filter used to hide.
        assert.deepEqual(store.map(p => String(p.barcode)), ['100', '101', '103', '104'])
        assert.deepEqual(fresh.map(p => String(p.barcode)), ['100', '101', '103', '104'])
    })
})
