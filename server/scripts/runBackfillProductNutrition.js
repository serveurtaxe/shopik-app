import boot from '../boot.js'
import backfillProductNutrition from './backfillProductNutrition.js'

// Backfill: derive Product.diet + nutrition flags (sugar/sodium/fat/positive/
// alcohol) from stored GS1 raw.
// Usage: node server/scripts/runBackfillProductNutrition.js [--dry-run]
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
console.log('[runBackfillProductNutrition] Boot done, starting...')
await backfillProductNutrition(bootData, {
    dryRun: !!flag('dry-run', false),
    limit: Number(flag('limit', 0)) || 0,
    page: Number(flag('page', 0)) || 0
})
console.log('[runBackfillProductNutrition] Done')
process.exit(0)
