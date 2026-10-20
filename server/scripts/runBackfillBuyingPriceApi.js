import boot from '../boot.js'
import backfillBuyingPriceApi from './backfillBuyingPriceApi.js'

const args = process.argv.slice(2)
const hasFlag = name => args.includes(`--${name}`)
const valueOf = name => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
}

const options = {
    limit: Number(valueOf('limit')) || 0,
    sample: Number(valueOf('sample')) || 0,
    concurrency: Number(valueOf('concurrency')) || undefined,
    dryRun: hasFlag('dry-run')
}

const bootData = await boot()

if (!process.env.COMAX_DELIVERY_PRICELIST_ID) {
    console.error('COMAX_DELIVERY_PRICELIST_ID is not configured')
    process.exit(1)
}

console.log('[runBackfillBuyingPriceApi] Boot done', JSON.stringify(options))

await backfillBuyingPriceApi(bootData, options)

console.log('[runBackfillBuyingPriceApi] Done')
process.exit(0)
