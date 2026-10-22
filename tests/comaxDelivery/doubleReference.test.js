import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseXml } from '../../server/external/comax/parser.js'
import { extractDeliveryDetails, groupDeliveryDocsByReference, docMatchesOrder } from '../../server/external/comax/deliveryFetch.js'
import { isDoubleReferenceError } from '../../server/external/comax/deliveryDocs.js'

const RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Get_DeliveryDocument_AllResponse xmlns="http://ws.comax.co.il/Comax_WebServices/">
      <Get_DeliveryDocument_AllResult>
        <GetDos_DetailsOut>
          <CustomerID>4800012</CustomerID>
          <DateDoc>22/10/2026 00:00:00</DateDoc>
          <StoreID>712</StoreID>
          <DocNumber>6833910</DocNumber>
          <Reference>100010</Reference>
          <TotalScm>223.79</TotalScm>
          <Cmt>5</Cmt>
          <ItemID>7290005317194</ItemID>
        </GetDos_DetailsOut>
        <GetDos_DetailsOut>
          <CustomerID>4800012</CustomerID>
          <DateDoc>22/10/2026 00:00:00</DateDoc>
          <StoreID>712</StoreID>
          <DocNumber>6833910</DocNumber>
          <Reference>100010</Reference>
          <TotalScm>223.79</TotalScm>
          <Cmt>1</Cmt>
          <ItemID>7290019603153</ItemID>
        </GetDos_DetailsOut>
        <GetDos_DetailsOut>
          <CustomerID>1710024</CustomerID>
          <DateDoc>15/10/2026 12:14:17</DateDoc>
          <StoreID>109</StoreID>
          <DocNumber>6830566</DocNumber>
          <Reference>10</Reference>
          <TotalScm>10</TotalScm>
          <Cmt>3</Cmt>
          <ItemID>7290014785564</ItemID>
        </GetDos_DetailsOut>
        <GetDos_DetailsOut xsi:nil="true" />
      </Get_DeliveryDocument_AllResult>
    </Get_DeliveryDocument_AllResponse>
  </soap:Body>
</soap:Envelope>`

describe('isDoubleReferenceError', () => {
    it('detects Comax "Double reference" in ErrorMessage', () => {
        assert.equal(isDoubleReferenceError({ ErrorMessage: 'Double reference' }), true)
    })

    it('detects it in ErrorMessage_Details', () => {
        assert.equal(isDoubleReferenceError({ ErrorMessage: '', ErrorMessage_Details: 'Double reference' }), true)
    })

    it('ignores other errors', () => {
        assert.equal(isDoubleReferenceError({ ErrorMessage: 'Invalid item' }), false)
        assert.equal(isDoubleReferenceError({}), false)
        assert.equal(isDoubleReferenceError(null), false)
    })
})

describe('groupDeliveryDocsByReference', () => {
    const rows = extractDeliveryDetails(parseXml(RESPONSE))

    it('keeps only the docs with the requested reference', () => {
        const docs = groupDeliveryDocsByReference(rows, '100010')
        assert.equal(docs.length, 1)
        assert.equal(docs[0].docNumber, '6833910')
        assert.equal(docs[0].storeId, '712')
        assert.equal(docs[0].totalSum, 223.79)
        assert.equal(docs[0].lines.length, 2)
    })

    it('returns the other chain doc that carries the same reference', () => {
        // The reference alone is NOT unique in the Comax company (another
        // chain uses 1..999) — the store check is what rejects it.
        const docs = groupDeliveryDocsByReference(rows, '10')
        assert.equal(docs.length, 1)
        assert.equal(docs[0].storeId, '109')
        assert.equal(docMatchesOrder(docs[0], {
            reference: '10',
            storeId: '712',
            expectedLines: [{ id: '7290014785564', qty: '3' }]
        }), false)
    })

    it('returns [] when nothing matches', () => {
        assert.deepEqual(groupDeliveryDocsByReference(rows, '404404'), [])
    })
})

describe('docMatchesOrder', () => {
    const doc = {
        docNumber: '6833910',
        reference: '100010',
        storeId: '712',
        lines: [
            { itemId: '7290005317194', qty: 5 },
            { itemId: '7290019603153', qty: 1 }
        ]
    }
    const expectedLines = [
        { id: '7290005317194', qty: '5' },
        { id: '7290019603153', qty: '1' }
    ]

    it('matches the same order (reference, store and lines)', () => {
        assert.equal(docMatchesOrder(doc, { reference: '100010', storeId: '712', expectedLines }), true)
    })

    it('rejects a different reference', () => {
        assert.equal(docMatchesOrder(doc, { reference: '100011', storeId: '712', expectedLines }), false)
    })

    it('rejects a different store', () => {
        assert.equal(docMatchesOrder(doc, { reference: '100010', storeId: '711', expectedLines }), false)
    })

    it('rejects different quantities', () => {
        const lines = [{ id: '7290005317194', qty: '4' }, { id: '7290019603153', qty: '1' }]
        assert.equal(docMatchesOrder(doc, { reference: '100010', storeId: '712', expectedLines: lines }), false)
    })

    it('rejects an extra item in the doc', () => {
        const withExtra = { ...doc, lines: [...doc.lines, { itemId: '7290000000000', qty: 1 }] }
        assert.equal(docMatchesOrder(withExtra, { reference: '100010', storeId: '712', expectedLines }), false)
    })

    it('sums quantities of an item Comax split into several lines', () => {
        const split = { ...doc, lines: [{ itemId: '7290005317194', qty: 3 }, { itemId: '7290005317194', qty: 2 }, { itemId: '7290019603153', qty: 1 }] }
        assert.equal(docMatchesOrder(split, { reference: '100010', storeId: '712', expectedLines }), true)
    })

    it('accepts an item id Comax returned as the barcode we sent', () => {
        const byBarcode = { ...doc, lines: [{ itemId: '111', qty: 5 }, { itemId: '222', qty: 1 }] }
        const lines = [{ id: '6', qty: '5' }, { id: '10', qty: '1' }]
        const aliasByBarcode = new Map([['111', '6'], ['222', '10']])
        assert.equal(docMatchesOrder(byBarcode, { reference: '100010', storeId: '712', expectedLines: lines, aliasByBarcode }), true)
    })
})
