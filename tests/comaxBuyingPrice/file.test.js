import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCsv, parseBuyingPriceCsv } from '../../server/external/comax/buyingPriceCsv.js'

const CSV = [
    '"מחירון: 255, נכון לתאריך 20/10/2026 ,מועד הדפסה: 08:51 20/10/2026",,,,',
    'מחירון,מחירון,ברקוד,שם פריט,מחיר ליחידה',
    '255,מחירון עלות - זכיינים,5,מאפה תרד,0.01',
    '255,מחירון עלות - זכיינים,11,"פולי קפה לק""ג",0.70',
    '255,מחירון עלות - זכיינים,10,בורקיטס,8.50',
    '1069,אתר,99,מוצר אתר,5.00',
    '255,מחירון עלות - זכיינים,,מוצר ללא ברקוד,3.00',
    '255,מחירון עלות - זכיינים,10,כפילות,9.99',
    '255,מחירון עלות - זכיינים,20,מחיר אפס,0',
    ''
].join('\r\n')

describe('parseCsv', () => {
    it('parses CRLF rows and unescapes quoted fields', () => {
        const rows = parseCsv(CSV)
        assert.equal(rows[0][0], 'מחירון: 255, נכון לתאריך 20/10/2026 ,מועד הדפסה: 08:51 20/10/2026')
        assert.equal(rows[3][3], 'פולי קפה לק"ג')
        assert.deepEqual(rows[2], ['255', 'מחירון עלות - זכיינים', '5', 'מאפה תרד', '0.01'])
    })
})

describe('parseBuyingPriceCsv', () => {
    it('keeps only the configured price list and positive prices', () => {
        const { prices } = parseBuyingPriceCsv(CSV, { priceListId: '255' })
        assert.equal(prices.get('5'), 0.01)
        assert.equal(prices.get('11'), 0.7)
        assert.equal(prices.has('99'), false)
    })

    it('skips blank barcodes and non-positive prices', () => {
        const { prices } = parseBuyingPriceCsv(CSV, { priceListId: '255' })
        assert.equal(prices.has(''), false)
        assert.equal(prices.has('20'), false)
    })

    it('last duplicate wins and conflicts are reported', () => {
        const { prices, conflicts } = parseBuyingPriceCsv(CSV, { priceListId: '255' })
        assert.equal(prices.get('10'), 9.99)
        assert.deepEqual(conflicts, [{ barcode: '10', from: 8.5, to: 9.99 }])
    })

    it('parses every list when no priceListId is given but ignores header/title rows', () => {
        const { prices } = parseBuyingPriceCsv(CSV)
        assert.equal(prices.get('99'), 5)
        assert.equal(prices.get('5'), 0.01)
    })
})
