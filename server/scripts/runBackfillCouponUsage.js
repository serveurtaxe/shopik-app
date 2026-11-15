import boot from '../boot.js'
import backfillCouponUsage from './backfillCouponUsage.js'

// Backfill: blacklist coupon usage from already-paid orders, cancel personal
// coupons that were used, and clean the affected open carts.
// Usage: node server/scripts/runBackfillCouponUsage.js [--dry-run] [--limit N]
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
console.log('[runBackfillCouponUsage] Boot done, starting...')
await backfillCouponUsage(bootData, {
    dryRun: !!flag('dry-run', false),
    limit: Number(flag('limit', 0)) || 0
})
console.log('[runBackfillCouponUsage] Done')
process.exit(0)
