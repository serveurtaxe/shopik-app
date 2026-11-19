import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeBarcode, parseAliasCsv, splitBarcodeCell } from '../../server/services/barcodeAliases/parse.js'

describe('barcode alias csv', () => {
    it('normalizes a barcode cell Excel turned into a scientific number', () => {
        assert.equal(normalizeBarcode('7.42259E+12'), '7422590000000')
        assert.equal(normalizeBarcode(' 7296082000202 '), '7296082000202')
        assert.equal(normalizeBarcode("'7290001201589"), '7290001201589')
        assert.equal(normalizeBarcode('ביצים'), '')
        assert.equal(normalizeBarcode('12'), '')
    })

    it('splits a secondary cell on newlines, commas, semicolons and spaces', () => {
        assert.deepEqual(
            splitBarcodeCell('693493255370\n7290001201589').barcodes,
            ['693493255370', '7290001201589']
        )
        assert.deepEqual(splitBarcodeCell('111,222; 333|444').barcodes, ['111', '222', '333', '444'])
        assert.deepEqual(splitBarcodeCell('111,לא,222'), { barcodes: ['111', '222'], invalid: ['לא'] })
    })

    it('reads the sheet columns by their Hebrew headers', () => {
        const csv = [
            'שם מוצר,ברקוד ראשי,ברקוד משני,קישור תמונה',
            'ביצים 12 יח׳ M,742259241895,"693493255370',
            '7290001201589",742259241895.png'
        ].join('\r\n')

        const { rows, errors } = parseAliasCsv(csv)
        assert.deepEqual(errors, [])
        assert.equal(rows.length, 1)
        assert.deepEqual(rows[0], {
            line: 2,
            name: 'ביצים 12 יח׳ M',
            mainBarcode: '742259241895',
            secondaries: ['693493255370', '7290001201589'],
            invalidSecondaries: [],
            category: ''
        })
    })

    it('reports a row whose main barcode is unusable instead of guessing', () => {
        const { rows, errors } = parseAliasCsv('שם מוצר,ברקוד ראשי,ברקוד משני\nללא ברקוד,לא-ברקוד,1234567890123')
        assert.deepEqual(rows, [])
        assert.deepEqual(errors, [{ line: 2, name: 'ללא ברקוד', mainBarcode: 'לא-ברקוד', reason: 'invalid_main' }])
    })

    it('drops the main barcode from its own secondary list and keeps line numbers', () => {
        const { rows } = parseAliasCsv('ברקוד ראשי,ברקוד משני\n1111111111111,1111111111111 2222222222222\n4444444444444,5555555555555')
        assert.deepEqual(rows.map(row => row.secondaries), [['2222222222222'], ['5555555555555']])
        assert.deepEqual(rows.map(row => row.line), [2, 3])
    })

    it('refuses a file without a main-barcode column', () => {
        assert.throws(() => parseAliasCsv('שם מוצר,ברקוד משני\nא,1111111111111'), { status: 400 })
        assert.throws(() => parseAliasCsv(''), { status: 400 })
    })
})
