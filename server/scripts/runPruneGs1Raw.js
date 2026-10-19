import boot from '../boot.js'
import pruneGs1Raw from './pruneGs1Raw.js'

// One-off backfill: strip empty values from stored gs1_products.raw.
// Usage: node server/scripts/runPruneGs1Raw.js [--dry-run]
//          [--limit N] [--page N] [--compact]
const args = process.argv.slice(2)
const flag = (name, def) => {
    const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`))
    if (i === -1) return def
    const eq = args[i].indexOf('=')
    if (eq !== -1) return args[i].slice(eq + 1)
    const next = args[i + 1]
    return next && !next.startsWith('--') ? next : true
}

const bootData = await boot()
console.log('[runPruneGs1Raw] Boot done, starting...')
await pruneGs1Raw(bootData, {
    dryRun: !!flag('dry-run', false),
    limit: Number(flag('limit', 0)) || 0,
    page: Number(flag('page', 0)) || 0,
    compact: !!flag('compact', false)
})
console.log('[runPruneGs1Raw] Done')
process.exit(0)