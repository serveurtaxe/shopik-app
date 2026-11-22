/**
 * One-off: populate `Product.totalSalesUnits` from a Comax sales report export.
 *
 * The report is a flat xlsx (one row per item per warehouse). Column E holds the
 * item number (EAN barcode, or an internal SKU for weighed/loose goods) and
 * column H the sold units (int, fractional for kg, negative for returns). Units
 * are summed per item across all warehouse rows, then written to the matching
 * `Product` by barcode.
 *
 * Only products whose barcode (or one of whose `scannableBarcodes`) matches a
 * report item are touched; everything else keeps its current value. A barcode
 * family is one product, so its report rows are summed into the owner instead
 * of splitting the total across docs that no longer exist. Items with no
 * matching product are ignored (internal SKUs, delisted goods). Items are
 * stored as numbers by Excel, so the file may have lost a leading zero — both
 * sides are normalized before comparing.
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

/**
 * Report items -> owning products, summed per family.
 *
 * A barcode family is one product: the report still has a row per barcode the
 * supplier sells under, and those rows must land on the owner rather than on
 * docs the alias import already removed. A product's own barcode wins, then
 * its aliases — the same precedence the alias index uses. Two products claiming
 * the same alias is ambiguous: the first one read keeps it and the collision is
 * counted (the import that created the alias makes this a report, not a write).
 *
 * @returns {{
 *   byOwner: Map<string, { product: object, units: number }>,
 *   unmatchedItems: number,
 *   duplicates: number
 * }}
 */
export function resolveFamilyTotals(products = [], totals = new Map()) {
    const byNorm = new Map()
    let duplicates = 0

    for (const product of products || []) {
        if (product?.barcode == null) continue
        const norm = normBarcode(product.barcode)
        if (byNorm.has(norm)) { duplicates++; continue }
        byNorm.set(norm, product)
    }
    for (const product of products || []) {
        if (product?.barcode == null) continue
        for (const alias of product.scannableBarcodes || []) {
            const norm = normBarcode(alias)
            if (byNorm.has(norm)) { duplicates++; continue }
            byNorm.set(norm, product)
        }
    }

    const byOwner = new Map()
    let unmatchedItems = 0
    for (const [norm, units] of totals) {
        const product = byNorm.get(norm)
        if (!product) { unmatchedItems++; continue }
        const entry = byOwner.get(product.barcode) || { product, units: 0 }
        entry.units += units
        byOwner.set(product.barcode, entry)
    }

    return { byOwner, unmatchedItems, duplicates }
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
        {}, { _id: 0, barcode: 1, scannableBarcodes: 1, totalSalesUnits: 1 }, { limit: 0 }
    )

    const { byOwner: totalsByOwner, unmatchedItems, duplicates } = resolveFamilyTotals(products, totals)

    const cap = Number(limit) || 0
    const updates = []
    let unchanged = 0
    for (const { product, units } of totalsByOwner.values()) {
        const value = Math.round(units * 1000) / 1000
        if (product.totalSalesUnits === value) { unchanged++; continue }
        updates.push({ barcode: product.barcode, totalSalesUnits: value })
        if (cap && updates.length >= cap) break
    }

    console.log(`[salesUnits] products: ${products?.length ?? 0} (dup normBarcode: ${duplicates})`)
    console.log(`[salesUnits] matched items: ${totals.size - unmatchedItems}, unmatched: ${unmatchedItems}, family owners: ${totalsByOwner.size}, unchanged: ${unchanged}, toWrite: ${updates.length}`)

    if (dryRun) {
        const top = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
        console.log(`[salesUnits] top report items: ${JSON.stringify(top)}`)
        console.log(`[salesUnits] sample updates: ${JSON.stringify(updates.slice(0, 5))}`)
        console.log('[salesUnits] DRY RUN — no writes')
        return { reportItems: totals.size, unmatchedItems, familyOwners: totalsByOwner.size, unchanged, updated: 0 }
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
    return { reportItems: totals.size, unmatchedItems, familyOwners: totalsByOwner.size, unchanged, updated: updates.length }
}
