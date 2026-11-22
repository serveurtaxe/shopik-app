import { readFileSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import boot from '../boot.js'
import { planBarcodeAliases } from '../services/barcodeAliases/index.js'

// Apply the barcode-family sheet ("ייבוא שיוך ברקודים") from the command line.
// Same service the admin modal calls (api/product/import_barcode_aliases), so
// the CLI and the UI can never plan different things.
//
// Usage: node server/scripts/importBarcodeAliasesCsv.js --file <file.csv>
//          [--apply] [--report <path.json>]        (no --apply = plan only)
const args = process.argv.slice(2)
const flag = (name, def) => {
    const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`))
    if (i === -1) return def
    const eq = args[i].indexOf('=')
    if (eq !== -1) return args[i].slice(eq + 1)
    const next = args[i + 1]
    return next && !next.startsWith('--') ? next : true
}

const file = flag('file', '')
const dryRun = !flag('apply', false)
const reportFile = flag('report', '')

if (!file) {
    console.error('Usage: node server/scripts/importBarcodeAliasesCsv.js --file <file.csv> [--apply] [--report <path.json>]')
    process.exit(1)
}

const bootData = await boot()
const report = await planBarcodeAliases({ csv: readFileSync(file, 'utf8'), dryRun }, bootData)

const out = reportFile || path.join(os.tmpdir(), `barcode-aliases-${dryRun ? 'plan' : 'applied'}-${Date.now()}.json`)
writeFileSync(out, JSON.stringify(report, null, 1))

console.log(`[barcodeAliases] file: ${file}${dryRun ? ' (DRY RUN — no writes)' : ''}`)
console.log(`[barcodeAliases] ${JSON.stringify(report.stats)}`)
for (const row of report.rows)
    console.log(`[barcodeAliases] row ${row.line} ${row.mainBarcode} ${row.mainName} → ${row.aliases.join(', ')}`
        + (row.aliasesRemoved.length ? ` | removes: ${row.aliasesRemoved.join(', ')}` : '')
        + (row.duplicates.length ? ` | deletes: ${row.duplicates.map(d => d.barcode).join(', ')}` : '')
        + (row.blocked ? ` | BLOCKED: ${row.blockers.map(b => `${b.reason}${b.barcode ? `(${b.barcode})` : ''}`).join(', ')}` : ''))
for (const error of report.errors)
    console.log(`[barcodeAliases] csv error row ${error.line}: ${error.reason} (${error.mainBarcode})`)
if (report.applied)
    console.log(`[barcodeAliases] applied: ${JSON.stringify({ ...report.applied, detail: undefined })}`)
console.log(`[barcodeAliases] report written: ${out}`)

process.exit(0)
