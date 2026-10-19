import boot from '../boot.js'
import backfillProductSalesUnits from './backfillProductSalesUnits.js'

// Usage:
//   node server/scripts/runBackfillProductSalesUnits.js --file <report.xlsx>
//        [--dry-run] [--limit N]
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
const dryRun = !!flag('dry-run', false)
const limit = Number(flag('limit', 0)) || 0

if (!file) {
    console.error('Usage: node server/scripts/runBackfillProductSalesUnits.js --file <report.xlsx> [--dry-run] [--limit N]')
    process.exit(1)
}

const bootData = await boot()
console.log('[runBackfillProductSalesUnits] Boot done, backfilling...')
const stats = await backfillProductSalesUnits(bootData, { file, dryRun, limit })
console.log(`[runBackfillProductSalesUnits] Done ${JSON.stringify(stats)}`)
process.exit(0)
