import { KASHRUT_CODE_INDEX, mergeRabbinates } from '#common/components/Kashrut/constants.js'

/**
 * Load kashrut onto products from a CSV ("טעינת כשרויות").
 *
 * The file is a mapping barcode → קוד כשרות (one rabbinate per row, several rows
 * may name the same rabbinate). Columns like שם מוצר / שם ספק / האם ב GS1 are not
 * data — the first two are only carried into the report so unmatched rows can be
 * traced, the last one is informational.
 *
 * Rabbinates are ADDED, never replaced: a row appends its code to whatever the
 * product already carries (GS1 or a previous load), deduped by code, so re-running
 * the same file is a no-op. `kashrut.supervisionType` is left untouched.
 *
 * dryRun (the default) plans everything and writes nothing — the admin sees the
 * counts and the rows that matched no product before committing.
 *
 * POST /api/product/load_kashrut { csv, dryRun? }
 */

const HEADERS = {
    barcode: 'ברקוד',
    code: 'קוד כשרות',
    name: 'שם מוצר'
}

const READ_CHUNK = 500
const WRITE_CHUNK = 500
const MAX_CSV_CHARS = 2_000_000
const CODE_SHAPE = /^\d{3,12}$/

// Headers are matched ignoring spaces and gershayim, so קוד כשרות / קוד"כשרות
// are the same column.
const normHeader = value => String(value ?? '').replace(/[\s\u05f4"']/g, '')

/**
 * Minimal CSV reader: quoted fields, "" escapes inside quotes, LF or CRLF,
 * optional BOM. A CSV dependency is not worth it for three numeric-ish columns.
 *
 * @returns {string[][]} raw rows, including the header row
 */
export function parseCsvRows(text) {
    const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
    const rows = []
    let row = [], field = '', quoted = false

    const endRow = () => { row.push(field); rows.push(row); row = []; field = '' }

    for (let i = 0; i < src.length; i++) {
        const ch = src[i]
        if (quoted) {
            if (ch != '"') { field += ch; continue }
            if (src[i + 1] == '"') { field += '"'; i++; continue }
            quoted = false
            continue
        }
        if (ch == '"') { quoted = true; continue }
        if (ch == ',') { row.push(field); field = ''; continue }
        if (ch == '\r') {
            if (src[i + 1] == '\n') i++
            endRow()
            continue
        }
        if (ch == '\n') { endRow(); continue }
        field += ch
    }
    if (field.length || row.length) endRow()
    return rows
}

/**
 * Header-mapped rows: [{ barcode, code, name }]. Rows without a barcode are
 * dropped (the export ends with a blank line). Duplicate barcodes are kept —
 * they become several codes for that product.
 */
export function parseKashrutCsv(text) {
    const rows = parseCsvRows(text)
    const header = rows[0] || []
    const col = {}
    header.forEach((cell, i) => {
        const key = normHeader(cell)
        for (const [field, label] of Object.entries(HEADERS))
            if (col[field] === undefined && key === normHeader(label)) col[field] = i
    })
    if (col.barcode === undefined || col.code === undefined)
        throw { status: 400, message: `CSV must have [${HEADERS.barcode}] and [${HEADERS.code}] columns` }

    return rows.slice(1)
        .map(row => ({
            barcode: String(row[col.barcode] ?? '').trim(),
            code: String(row[col.code] ?? '').trim(),
            name: col.name === undefined ? '' : String(row[col.name] ?? '').trim()
        }))
        .filter(row => row.barcode)
}

/**
 * Plan one product: merge the new codes over what it already has.
 * Legacy products stored `kashrut` as a plain string, which the UI ignores —
 * those are rewritten to the object shape (counted as legacyConverted).
 *
 * @returns {{ changed: boolean, legacy: boolean, kashrut: object }}
 */
export function planKashrutUpdate(kashrut, additions) {
    const legacy = typeof kashrut === 'string' || Array.isArray(kashrut)
    const current = kashrut && typeof kashrut === 'object' && !legacy ? kashrut : {}
    const existing = Array.isArray(current.rabbinates) ? current.rabbinates : []
    const rabbinates = mergeRabbinates(existing, additions.map(code => ({ code })))
    const changed = JSON.stringify(rabbinates) !== JSON.stringify(existing) || legacy
    return {
        changed,
        legacy,
        kashrut: { ...current, rabbinates }
    }
}

export default async function loadKashrut(payload, { DL }) {
    const csv = typeof payload?.csv === 'string' ? payload.csv : ''
    const dryRun = payload?.dryRun !== false
    if (!csv.trim()) throw { status: 400, message: 'missing csv' }
    if (csv.length > MAX_CSV_CHARS)
        throw { status: 400, message: `csv too large (max ${MAX_CSV_CHARS} characters)` }

    const rows = parseKashrutCsv(csv)
    if (!rows.length) throw { status: 400, message: 'csv has no rows' }

    // Unknown codes are reported, not written: an unlisted code renders as an
    // unnamed text stamp, so a typo would silently add noise to the catalog.
    const wanted = new Map()
    const invalid = []
    for (const row of rows) {
        if (!CODE_SHAPE.test(row.code) || !KASHRUT_CODE_INDEX.has(row.code)) {
            invalid.push({ barcode: row.barcode, code: row.code, name: row.name })
            continue
        }
        if (!wanted.has(row.barcode)) wanted.set(row.barcode, { codes: [], name: row.name })
        wanted.get(row.barcode).codes.push(row.code)
    }

    const barcodes = [...wanted.keys()]
    const productByBarcode = new Map()
    for (let i = 0; i < barcodes.length; i += READ_CHUNK) {
        const chunk = barcodes.slice(i, i + READ_CHUNK)
        // The report is keyed by barcode; a row for a scan alias belongs to the
        // product that owns that barcode.
        const found = await DL.Product.read(
            { $or: [{ barcode: { $in: chunk } }, { scannableBarcodes: { $in: chunk } }] },
            { _id: 0, barcode: 1, scannableBarcodes: 1, kashrut: 1 },
            { limit: 0 }
        )
        for (const product of found || []) {
            if (!product?.barcode) continue
            if (!productByBarcode.has(product.barcode)) productByBarcode.set(product.barcode, product)
            for (const alias of product.scannableBarcodes || [])
                if (!productByBarcode.has(String(alias))) productByBarcode.set(String(alias), product)
        }
    }

    const unmatched = []
    const updates = []
    let unchanged = 0, legacyConverted = 0

    for (const [barcode, { codes, name }] of wanted) {
        const product = productByBarcode.get(barcode)
        if (!product) {
            unmatched.push({ barcode, name })
            continue
        }
        const plan = planKashrutUpdate(product.kashrut, codes)
        if (plan.legacy) legacyConverted++
        if (!plan.changed) { unchanged++; continue }
        // Always the product's own barcode: a row can name a scan alias, and a
        // $set keyed by the alias would match no document.
        updates.push({ barcode: product.barcode, kashrut: plan.kashrut })
    }

    const report = {
        dryRun,
        rows: rows.length,
        barcodes: barcodes.length,
        matched: updates.length + unchanged,
        updated: updates.length,
        unchanged,
        legacyConverted,
        invalid,
        unmatched
    }

    if (dryRun || !updates.length) return report

    for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
        const chunk = updates.slice(i, i + WRITE_CHUNK)
        await DL.Product.bulkWrite({
            docs: chunk,
            getFilter: doc => ({ barcode: doc.barcode }),
            getUpsert: () => false,
            getUpdate: doc => ({ $set: { kashrut: doc.kashrut } })
        })
    }
    return report
}

loadKashrut.config = {
    required: ['csv'],
    permissions: ['product:update'],
    preventMultiple: true
}
