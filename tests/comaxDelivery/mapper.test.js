import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildDeliveryDocumentSoap } from '../../server/external/comax/deliveryMapper.js'

const CFG = {
    customerId: '102',
    comaxStoreId: '3',
    priceListId: '255',
    loginId: 'TEST',
    loginPassword: 'TEST',
    idByBarcode: new Map([['7290000000001', '6']])
}

function makeOrder(over = {}) {
    return {
        number: '3535',
        name: { first: 'John', last: 'Doe' },
        phone: '0542000111',
        email: 'john@example.com',
        address: { street: 'Main St', building: 40, apartment: 1, city: 'Tel Aviv', comment: 'Ring twice' },
        cart: [
            { barcode: '7290000000001', amount: 2, finalAmount: 2 },
            { barcode: '7290000000002', amount: 1, finalAmount: 3 }
        ],
        ...over
    }
}

describe('buildDeliveryDocumentSoap', () => {
    it('builds a Write_DeliveryDocument envelope with mandatory tags', () => {
        const { xml, lines } = buildDeliveryDocumentSoap(makeOrder(), CFG)
        assert.equal(lines.length, 2)
        assert.match(xml, /<Write_DeliveryDocument xmlns="http:\/\/ws\.comax\.co\.il\/Comax_WebServices\/">/)
        assert.match(xml, /<DocumentDetails>/)
        assert.match(xml, /<CustomerID>102<\/CustomerID>/)
        assert.match(xml, /<StoreID>3<\/StoreID>/)
        assert.match(xml, /<PriceListID>255<\/PriceListID>/)
        assert.match(xml, /<PriceFromPriceList>true<\/PriceFromPriceList>/)
        assert.match(xml, /<Reference>3535<\/Reference>/)
        assert.match(xml, /<DoubleReferenceChk>true<\/DoubleReferenceChk>/)
        assert.match(xml, /<SetItemPriceByOrder>false<\/SetItemPriceByOrder>/)
        assert.match(xml, /<LoginID>TEST<\/LoginID>/)
    })

    it('resolves comaxId by barcode and falls back to barcode', () => {
        const { xml, lines } = buildDeliveryDocumentSoap(makeOrder(), CFG)
        assert.deepEqual(lines, [
            { id: '6', qty: '2' },
            { id: '7290000000002', qty: '3' }
        ])
        assert.match(xml, /<ID>6<\/ID><Quantity>2<\/Quantity>/)
        assert.match(xml, /<ID>7290000000002<\/ID><Quantity>3<\/Quantity>/)
    })

    it('sends ID+Quantity per line only, no price tags (price list rules)', () => {
        const { xml } = buildDeliveryDocumentSoap(makeOrder(), CFG)
        assert.doesNotMatch(xml, /<Price>/)
        assert.match(xml, /<ClsItems><ID>6<\/ID><Quantity>2<\/Quantity><\/ClsItems>/)
    })

    it('omits missing and zero-qty lines', () => {
        const order = makeOrder({
            cart: [
                { barcode: 'A', amount: 1, finalAmount: 0 },
                { barcode: 'B', amount: 2 },
                { barcode: '', amount: 5, finalAmount: 5 }
            ]
        })
        const { lines } = buildDeliveryDocumentSoap(order, CFG)
        assert.deepEqual(lines, [{ id: 'B', qty: '2' }])
    })

    it('escapes XML special chars in customer fields', () => {
        const order = makeOrder({ name: { first: 'A&B', last: '<C>' } })
        const { xml } = buildDeliveryDocumentSoap(order, CFG)
        assert.match(xml, /<Name>A&amp;B &lt;C&gt;<\/Name>/)
        const flat = buildDeliveryDocumentSoap(order, CFG, { flatSiblings: true }).xml
        assert.match(flat, /<CustomerName>A&amp;B &lt;C&gt;<\/CustomerName>/)
        assert.doesNotMatch(flat, /<CustomerName>A&B/)
    })
})
