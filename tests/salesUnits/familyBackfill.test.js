import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateUnits, resolveFamilyTotals } from '../../server/scripts/backfillProductSalesUnits.js'

describe('sales report family backfill', () => {
    it('sums every barcode of a family onto the owning product', () => {
        const totals = new Map([['1111111111111', 519], ['2222222222222', 207], ['3333333333333', 0]])
        const products = [
            { barcode: '1111111111111', totalSalesUnits: 519, scannableBarcodes: ['2222222222222', '3333333333333'] }
        ]

        const { byOwner, unmatchedItems, duplicates } = resolveFamilyTotals(products, totals)

        assert.equal(unmatchedItems, 0)
        assert.equal(duplicates, 0)
        assert.deepEqual([...byOwner], [['1111111111111', { product: products[0], units: 726 }]])
    })

    it('matches a report row to the owner even when the main barcode is absent', () => {
        const totals = new Map([['2222222222222', 48]])
        const products = [{ barcode: '1111111111111', totalSalesUnits: 0, scannableBarcodes: ['2222222222222'] }]

        const { byOwner } = resolveFamilyTotals(products, totals)
        assert.equal(byOwner.get('1111111111111').units, 48)
    })

    it('prefers a real product barcode over another product\'s alias', () => {
        const totals = new Map([['2222222222222', 7]])
        const products = [
            { barcode: '1111111111111', scannableBarcodes: ['2222222222222'] },
            { barcode: '2222222222222' }
        ]

        const { byOwner, duplicates } = resolveFamilyTotals(products, totals)
        assert.deepEqual([...byOwner.keys()], ['2222222222222'])
        assert.equal(duplicates, 1)
    })

    it('ignores a report item that matches no product', () => {
        const totals = new Map([['999999', 3]])
        const { byOwner, unmatchedItems } = resolveFamilyTotals([{ barcode: '1111111111111' }], totals)
        assert.equal(byOwner.size, 0)
        assert.equal(unmatchedItems, 1)
    })

    it('normalizes the leading zero the report file loses', () => {
        const xml = [
            '<sheetData>',
            '<row r="3"><c r="E3"><v>0123456789012</v></c><c r="H3"><v>5</v></c></row>',
            '<row r="4"><c r="E4"><v>123456789012</v></c><c r="H4"><v>7</v></c></row>',
            '</sheetData>'
        ].join('')

        const totals = aggregateUnits(xml)
        assert.equal(totals.get('123456789012'), 12)
    })
})
