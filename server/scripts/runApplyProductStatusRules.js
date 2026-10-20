import boot from '../boot.js'
import applyProductStatusRules from './applyProductStatusRules.js'

// Usage:
//   node server/scripts/runApplyProductStatusRules.js --barcodes <file.txt>
//        [--dry-run] [--limit N] [--rollback <path.json>]
const args = process.argv.slice(2)
const flag = (name, def) => {
    const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`))
    if (i === -1) return def
    const eq = args[i].indexOf('=')
    if (eq !== -1) return args[i].slice(eq + 1)
    const next = args[i + 1]
    return next && !next.startsWith('--') ? next : true
}

const barcodesFile = flag('barcodes', '')
const dryRun = !!flag('dry-run', false)
const limit = Number(flag('limit', 0)) || 0
const rollbackFile = flag('rollback', '')

if (!barcodesFile) {
    console.error('Usage: node server/scripts/runApplyProductStatusRules.js --barcodes <file.txt> [--dry-run] [--limit N] [--rollback <path.json>]')
    process.exit(1)
}

const bootData = await boot()
console.log('[runApplyProductStatusRules] Boot done, applying...')
const stats = await applyProductStatusRules(bootData, { barcodesFile, dryRun, limit, rollbackFile })
console.log(`[runApplyProductStatusRules] Done ${JSON.stringify(stats)}`)
process.exit(0)
