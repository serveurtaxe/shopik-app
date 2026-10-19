import boot from '../boot.js'
import gs1ReportSeed from './gs1ReportSeed.js'
import { runEnrich } from '#server/services/gs1/enrich.js'
import { initBulkFlusher, flush } from '#server/services/gs1/bulk.js'

// One-off: seed gs1_products from a GS1 portal report export, then run text enrich.
// Usage:
//   node server/scripts/runGs1ReportSeed.js --file <rows.jsonl> --headers <headers.json>
//        [--dry-run] [--limit N] [--no-enrich]
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
const headersFile = flag('headers', '')
const dryRun = !!flag('dry-run', false)
const limit = Number(flag('limit', 0)) || 0
const doEnrich = !flag('no-enrich', false)

if (!file || !headersFile) {
    console.error('Usage: node server/scripts/runGs1ReportSeed.js --file <rows.jsonl> --headers <headers.json> [--dry-run] [--limit N] [--no-enrich]')
    process.exit(1)
}

const bootData = await boot()
console.log('[runGs1ReportSeed] Boot done, seeding...')
const stats = await gs1ReportSeed(bootData, { file, headersFile, dryRun, limit })

if (!dryRun && doEnrich) {
    initBulkFlusher(bootData.DL)
    const runId = `reportseed:${Date.now()}`
    console.log('[runGs1ReportSeed] Enriching texts...')
    const totals = await runEnrich({
        DL: bootData.DL,
        external: bootData.external,
        runId,
        onlyInStock: false
    })
    await flush()
    console.log(`[runGs1ReportSeed] Enrich done: ${JSON.stringify(totals)}`)
}
console.log(`[runGs1ReportSeed] Done ${JSON.stringify({ ...stats, nutUnmatched: stats?.nutUnmatched?.size ?? 0 })}`)
process.exit(0)
