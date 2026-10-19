import boot from '../boot.js'
import reconcileWindowGroupCounts from './reconcileWindowGroupCounts.js'

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
console.log('[runReconcileWindowGroupCounts] Boot done, starting...')
await reconcileWindowGroupCounts(bootData, { dryRun: !!flag('dry-run', false) })
console.log('[runReconcileWindowGroupCounts] Done')
process.exit(0)
