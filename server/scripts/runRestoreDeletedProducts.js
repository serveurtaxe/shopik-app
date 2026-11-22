import boot from '../boot.js'
import restoreDeletedProducts from './restoreDeletedProducts.js'

// Usage:
//   node server/scripts/runRestoreDeletedProducts.js --barcode <barcode>
//        | --main <mainBarcode> | --all   [--dry-run] [--limit N]
const args = process.argv.slice(2)
const flag = (name, def) => {
    const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`))
    if (i === -1) return def
    const eq = args[i].indexOf('=')
    if (eq !== -1) return args[i].slice(eq + 1)
    const next = args[i + 1]
    return next && !next.startsWith('--') ? next : true
}

const barcode = String(flag('barcode', '') || '')
const mainBarcode = String(flag('main', '') || '')
const all = !!flag('all', false)
const dryRun = !!flag('dry-run', false)
const limit = Number(flag('limit', 0)) || 0

if (!barcode && !mainBarcode && !all) {
    console.error('Usage: node server/scripts/runRestoreDeletedProducts.js [--barcode <barcode> | --main <mainBarcode> | --all] [--dry-run] [--limit N]')
    process.exit(1)
}

const bootData = await boot()
console.log('[runRestoreDeletedProducts] Boot done, restoring...')
const stats = await restoreDeletedProducts(bootData, { barcode, mainBarcode, all, dryRun, limit })
console.log(`[runRestoreDeletedProducts] Done ${JSON.stringify(stats)}`)
process.exit(0)
