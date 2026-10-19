import boot from '../boot.js'
import scrapeProductImages from './scrapeProductImages.js'

// Usage: node server/scripts/runScrapeProductImages.js --barcode 7290000066318 [--dry-run] [--force] [--providers rami-levy,super-pharm]
//        node server/scripts/runScrapeProductImages.js --imageless [--limit N] [--dry-run] [--force] [--concurrency N] [--providers rami-levy,super-pharm]
//        node server/scripts/runScrapeProductImages.js --folder "C:\path\to\imgs" [--limit N] [--dry-run] [--concurrency N]
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
console.log('[runScrapeProductImages] Boot done, starting...')
await scrapeProductImages(bootData, {
    barcode: String(flag('barcode', '') || ''),
    folder: String(flag('folder', '') || ''),
    imageless: !!flag('imageless', false),
    limit: Number(flag('limit', 0)) || 0,
    force: !!flag('force', false),
    dryRun: !!flag('dry-run', false),
    concurrency: Number(flag('concurrency', 3)) || 3,
    providers: String(flag('providers', '') || ''),
    delayMs: Number(flag('delay-ms', 0)) || 0,
    retryFailed: !!flag('retry-failed', false),
    nameMatch: String(flag('name-match', '') || '')
})
console.log('[runScrapeProductImages] Done')
process.exit(0)
