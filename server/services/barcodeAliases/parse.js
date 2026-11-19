// CSV parsing for the barcode-alias import ("ייבוא שיוך ברקודים").
//
// The file is the sheet the team already maintains:
//
//   שם מוצר | ברקוד ראשי | ברקוד משני | קישור תמונה
//   ביצים 12 יח' M | 742259241895 | 693493255370\n7290001201589 | 742259241895.png
//
// Only the three data columns are read; the image column is a Drive link the
// upload modal handles separately. Secondary cells hold any number of barcodes
// separated by newlines (a quoted cell), commas, semicolons or spaces.
//
// The parser is deliberately forgiving about *format* (Excel loves to
// re-format long numbers) and strict about *identity*: a token that does not
// come back as digits is reported, never guessed at.

import { parseCsvRows } from '#server/services/categoryMap/parse.js'

export const ALIAS_HEADERS = {
    name: ['שם מוצר', 'שם', 'name', 'productname'],
    main: ['ברקוד ראשי', 'ברקוד', 'mainbarcode', 'barcode'],
    secondary: ['ברקוד משני', 'ברקודים משניים', 'scannablebarcodes', 'secondarybarcodes', 'secondaries'],
    category: ['קטגוריה', 'category', 'categoryid']
}

// Headers are matched ignoring spaces and Hebrew/ASCII quote marks, so
// "ברקוד משני" / "ברקוד  משני" / "ברקוד"משני" are the same column.
const normHeader = value => String(value ?? '')
    .replace(/[\s\u05f4\u05f3"'`]/g, '')
    .toLowerCase()

const DIGITS = /^\d+$/

/**
 * Normalise one cell to a barcode string, or '' when it cannot be one.
 *
 * - Excel may serialise a long number as `7.42259E+12`; expand it (safe for
 *   barcodes, which stay far below Number.MAX_SAFE_INTEGER). A lossy scientific
 *   cell simply fails to match a product later, so it surfaces as an error
 *   instead of silently aliasing the wrong item.
 * - Leading zeros are preserved when they are literally present; they are
 *   already lost in a numeric cell, which is why Comax/GS1 comparisons are
 *   documented as string comparisons elsewhere.
 */
export function normalizeBarcode(value) {
    let text = String(value ?? '').trim().replace(/^['"`]+|['"`]+$/g, '')
    if (!text) return ''

    if (/^\d+(?:\.\d+)?e\+?\d+$/i.test(text)) {
        const number = Number(text)
        if (Number.isFinite(number) && number > 0) text = BigInt(Math.round(number)).toString()
    }

    text = text.replace(/[\s'`"]/g, '')
    return DIGITS.test(text) && text.length >= 3 && text.length <= 14 ? text : ''
}

function rawTokens(value) {
    return String(value ?? '')
        .split(/[\s,;|]+/)
        .map(token => token.trim())
        .filter(Boolean)
}

export function splitBarcodeCell(value) {
    const valid = []
    const invalid = []
    for (const token of rawTokens(value)) {
        const barcode = normalizeBarcode(token)
        if (barcode) valid.push(barcode)
        else invalid.push(token)
    }
    return { barcodes: valid, invalid }
}

/**
 * @returns {{
 *   rows: Array<{ line: number, name: string, mainBarcode: string,
 *                 secondaries: string[], invalidSecondaries: string[], category: string }>,
 *   errors: Array<{ line: number, name: string, mainBarcode: string, reason: string }>
 * }}
 */
export function parseAliasCsv(text = '') {
    const rows = parseCsvRows(text)
    if (!rows.length) throw { status: 400, message: 'CSV is empty' }

    const col = {}
    const header = rows[0] || []
    header.forEach((cell, index) => {
        const key = normHeader(cell)
        for (const [field, labels] of Object.entries(ALIAS_HEADERS)) {
            if (col[field] !== undefined) continue
            if (labels.some(label => normHeader(label) === key)) col[field] = index
        }
    })

    if (col.main === undefined)
        throw { status: 400, message: `CSV must have a main-barcode column (${ALIAS_HEADERS.main[0]})` }

    const parsed = []
    const errors = []

    rows.slice(1).forEach((cells, index) => {
        const line = index + 2
        const name = col.name === undefined ? '' : String(cells[col.name] ?? '').trim()
        const rawMain = col.main === undefined ? '' : String(cells[col.main] ?? '').trim()
        const category = col.category === undefined ? '' : String(cells[col.category] ?? '').trim()

        // The export ends with a blank line; a row with only a name is a real
        // data problem (nothing to attach the name to).
        if (!rawMain && !name && !category) return

        const mainBarcode = normalizeBarcode(rawMain)
        if (!mainBarcode) {
            errors.push({ line, name, mainBarcode: rawMain, reason: 'invalid_main' })
            return
        }

        const { barcodes, invalid } = col.secondary === undefined
            ? { barcodes: [], invalid: [] }
            : splitBarcodeCell(cells[col.secondary])

        parsed.push({
            line,
            name,
            mainBarcode,
            // A cell that repeats the main barcode is simply the family head.
            secondaries: [...new Set(barcodes)].filter(barcode => barcode !== mainBarcode),
            invalidSecondaries: invalid,
            category
        })
    })

    return { rows: parsed, errors }
}
