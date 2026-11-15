import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import buildXlsx from '../../server/reports/xlsx.js'

const COLUMNS = [
    { text: 'ברקוד', width: 14, align: 'center', asText: true },
    { text: 'שם מוצר', width: 20, align: 'right' },
    { text: 'מחיר מכירה', width: 12, align: 'left', money: true },
    { text: 'האם בסניף בת ים', width: 16, align: 'center' }
]

const ROWS = [
    ['0729000000015', 'מוצר א', 12.5, 'כן'],
    ['123', '', null, 'לא']
]

async function readBack(columns = COLUMNS, rows = ROWS) {
    const buffer = await buildXlsx({ columns, rows, sheetName: 'דוח מוצרים' })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(buffer)
    return { workbook, sheet: workbook.worksheets[0], buffer }
}

describe('report xlsx writer', () => {
    it('writes the header row and one row per data row', async () => {
        const { sheet } = await readBack()
        assert.equal(sheet.rowCount, ROWS.length + 1)
        assert.deepEqual(
            sheet.getRow(1).values.slice(1),
            COLUMNS.map(column => column.text)
        )
        assert.deepEqual(sheet.getRow(2).values.slice(1), ROWS[0])
    })

    it('keeps the sheet RTL with a frozen header and an autofilter', async () => {
        const { sheet } = await readBack()
        assert.equal(sheet.views[0].rightToLeft, true)
        assert.equal(sheet.views[0].state, 'frozen')
        assert.equal(sheet.views[0].ySplit, 1)
        assert.equal(sheet.autoFilter, 'A1:D1')
    })

    it('formats barcodes as text and prices as numbers', async () => {
        const { sheet } = await readBack()
        const barcode = sheet.getRow(2).getCell(1)
        const price = sheet.getRow(2).getCell(3)

        assert.equal(barcode.value, '0729000000015')
        assert.equal(barcode.numFmt, '@')
        assert.equal(price.type, ExcelJS.ValueType.Number)
        assert.equal(price.value, 12.5)
        assert.equal(price.numFmt, '#,##0.00')
    })

    it('leaves an empty cell empty instead of writing a placeholder', async () => {
        const { sheet } = await readBack()
        assert.equal(sheet.getRow(3).getCell(2).value, null)
        assert.equal(sheet.getRow(3).getCell(3).value, null)
    })

    it('wraps only the columns that ask for it', async () => {
        const { sheet } = await readBack(
            [
                { text: 'ברקוד', width: 14, align: 'center' },
                { text: 'סיבה', width: 30, align: 'right', wrap: true }
            ],
            [['123', 'סיבה ארוכה מאוד']]
        )

        assert.equal(sheet.getRow(2).getCell(2).alignment.wrapText, true)
        assert.ok(!sheet.getRow(2).getCell(1).alignment.wrapText)
    })
})
