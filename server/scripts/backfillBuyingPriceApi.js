import backfillComaxBuyingPrices from '../api/comax_product/backfill_buying_price_api.js'

export default async function backfillBuyingPriceApi(bootData, options = {}) {
    console.log('[backfillBuyingPriceApi] Starting...')
    const result = await backfillComaxBuyingPrices(options, bootData)
    console.log('[backfillBuyingPriceApi] Result:', JSON.stringify(result))
    return result
}
