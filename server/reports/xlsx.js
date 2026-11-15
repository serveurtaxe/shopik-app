import ExcelJS from 'exceljs'
import { PassThrough } from 'node:stream'

/**
 * Rows → xlsx buffer.
 *
 * The streaming writer keeps memory flat for the ~20k row catalog report (a
 * plain Workbook would hold a cell object per cell). The sheet look mirrors
 * the report ops already use: RTL, dark header row, frozen header, autofilter,
 * barcodes as text, prices with two decimals.
 */

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } }
const HEADER_FONT = { name: 'Arial', bold: true, color: { argb: 'FFFFFFFF' }, size: 11 }
const BODY_FONT = { name: 'Arial', size: 10 }
const THIN = { style: 'thin', color: { argb: 'FFD9D9D9' } }
const BORDER = { top: THIN, left: THIN, bottom: THIN, right: THIN }

export default async function buildXlsx({ columns, rows, sheetName }) {
    const output = new PassThrough()
    const chunks = []
    const finished = new Promise((resolve, reject) => {
        output.on('data', chunk => chunks.push(chunk))
        output.on('end', resolve)
        output.on('error', reject)
    })

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
        stream: output,
        useStyles: true,
        useSharedStrings: false
    })

    const sheet = workbook.addWorksheet(sheetName, {
        views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }]
    })

    // Column widths and the filter must be declared before the first row is
    // committed — the streaming writer flushes the sheet header then.
    sheet.columns = columns.map(column => ({ width: column.width }))
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } }

    const header = sheet.addRow(columns.map(column => column.text))
    header.height = 30
    columns.forEach((column, index) => {
        const cell = header.getCell(index + 1)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.border = BORDER
        cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true }
    })
    header.commit()

    for (const values of rows) {
        const row = sheet.addRow(values)
        values.forEach((value, index) => {
            const column = columns[index]
            const cell = row.getCell(index + 1)
            cell.font = BODY_FONT
            cell.border = BORDER
            cell.alignment = { horizontal: column.align, vertical: 'middle', ...(column.wrap ? { wrapText: true } : {}) }
            if (column.asText) cell.numFmt = '@'
            else if (column.money) cell.numFmt = '#,##0.00'
        })
        row.commit()
    }

    await workbook.commit()
    await finished

    return Buffer.concat(chunks)
}
