/**
 * One-off: populate `Product.totalSalesUnits` from a Comax sales report export.
 *
 * The report is a flat xlsx (one row per item per warehouse). Column E holds the
 * item number (EAN barcode, or an internal SKU for weighed/loose goods) and
 * column H the sold units (int, fractional for kg, negative for returns). Units
 * are summed per item across all warehouse rows, then written to the matching
 * `Product` by barcode.
 *
 * Only products whose barcode matches a report item are touched; everything else
 * keeps its current value. Items with no matching product are ignored (internal
 * SKUs, delisted goods). Items are stored as numbers by Excel, so the file may
 * have lost a leading zero — both sides are normalized before comparing.
 *
 * Usage: node server/scripts/runBackfillProductSalesUnits.js --file <report.xlsx>
 *          [--dry-run] [--limit N]
 */
import { readFileSync } from 'fs'
import { unzipSync } from 'fflate'

const DIGITS = /^\d+$/

// barcode ↔ item (Comax stores numbers without the leading zero). Never
// numeric: '0123456' and '123456' must stay distinguishable elsewhere.
const normBarcode = s => {
    const t = String(s).trim()
    return DIGITS.test(t) ? t.replace(/^0+(?=\d)/, '') : t
}

// xlsx is a zip; the numbers we need live as `<c r="E3"><v>…</v></c>` in the
// worksheet XML. Only E/H are read, so sharedStrings is never touched.
function readSheetXml(file) {
    const zip = unzipSync(new Uint8Array(readFileSync(file)))
    const key = Object.keys(zip).find(k => /^xl\/worksheets\/sheet\d*\.xml$/.test(k))
    if (!key) throw new Error(`no worksheet xml in ${file}`)
    return new TextDecoder().decode(zip[key])
}

function cellValues(xml, col) {
    const re = new RegExp(`<c r="${col}(\\d+)"([^>]*)>(?:<v>([^<]*)</v>)?</c>`, 'g')
    const byRow = new Map()
    let m
    while ((m = re.exec(xml))) {
        if (/t="s"/.test(m[2])) continue // shared string (e.g. header) — not a value
        if (m[3] != null) byRow.set(Number(m[1]), m[3])
    }
    return byRow
}

// item -> summed units. Header row 2 has a non-numeric item and is skipped.
export function aggregateUnits(xml) {
    const items = cellValues(xml, 'E')
    const units = cellValues(xml, 'H')
    const totals = new Map()
    for (const [row, item] of items) {
        if (!DIGITS.test(String(item).trim())) continue
        const v = Number(units.get(row) || 0)
        const key = normBarcode(item)
        totals.set(key, (totals.get(key) || 0) + v)
    }
    return totals
}

export default async function backfillProductSalesUnits(
    { DL } = {},
    { file, dryRun = false, limit = 0 } = {}
) {
    if (!DL?.Product?.Model) throw new Error('DL required')
    if (!file) throw new Error('file (xlsx path) is required')

    console.log(`[salesUnits] reading ${file}${dryRun ? ' (DRY RUN — no writes)' : ''}`)
    const totals = aggregateUnits(readSheetXml(file))
    console.log(`[salesUnits] report items: ${totals.size}`)

    const products = await DL.Product.read(
        {}, { _id: 0, barcode: 1, totalSalesUnits: 1 }, { limit: 0 }
    )
    const byNorm = new Map()
    let duplicates = 0
    for (const p of products || []) {
        if (p?.barcode == null) continue
        const n = normBarcode(p.barcode)
        if (byNorm.has(n)) { duplicates++; continue }
        byNorm.set(n, p)
    }

    const cap = Number(limit) || 0
    const updates = []
    let unmatchedItems = 0
    let unchanged = 0
    for (const [norm, units] of totals) {
        const p = byNorm.get(norm)
        if (!p) { unmatchedItems++; continue }
        const value = Math.round(units * 1000) / 1000
        if (p.totalSalesUnits === value) { unchanged++; continue }
        updates.push({ barcode: p.barcode, totalSalesUnits: value })
        if (cap && updates.length >= cap) break
    }

    console.log(`[salesUnits] products: ${products?.length ?? 0} (dup normBarcode: ${duplicates})`)
    console.log(`[salesUnits] matched items: ${totals.size - unmatchedItems}, unmatched: ${unmatchedItems}, unchanged: ${unchanged}, toWrite: ${updates.length}`)

    if (dryRun) {
        const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        console.log(`[salesUnits] top report items: ${JSON.stringify(top)}`)
        console.log(`[salesUnits] sample updates: ${JSON.stringify(updates.slice(0, 5))}`)
        console.log('[salesUnits] DRY RUN — no writes')
        return { reportItems: totals.size, unmatchedItems, unchanged, updated: 0 }
    }

    if (updates.length) {
        const res = await DL.Product.bulkWrite({
            docs: updates,
            getFilter: d => ({ barcode: d.barcode }),
            getUpsert: () => false,
            getUpdate: d => ({ $set: { totalSalesUnits: d.totalSalesUnits } })
        })
        console.log(`[salesUnits] done — modified ${res?.modifiedCount ?? 0}`)
    }
    return { reportItems: totals.size, unmatchedItems, unchanged, updated: updates.length }
}
