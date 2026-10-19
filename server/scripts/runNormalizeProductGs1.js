import boot from '../boot.js'
import normalizeProductGs1 from './normalizeProductGs1.js'

// One-off backfill: normalize stored Product.gs1 to the pruned shape.
// Usage: node server/scripts/runNormalizeProductGs1.js [--dry-run]
//          [--limit N] [--page N]
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
console.log('[runNormalizeProductGs1] Boot done, starting...')
await normalizeProductGs1(bootData, {
    dryRun: !!flag('dry-run', false),
    limit: Number(flag('limit', 0)) || 0,
    page: Number(flag('page', 0)) || 0
})
console.log('[runNormalizeProductGs1] Done')
process.exit(0)