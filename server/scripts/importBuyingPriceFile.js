import importComaxBuyingPriceFile from '../api/comax_product/import_buying_price_file.js'

export default async function importBuyingPriceFile(bootData, options = {}) {
    console.log('[importBuyingPriceFile] Starting...')
    const result = await importComaxBuyingPriceFile(options, bootData)
    console.log('[importBuyingPriceFile] Result:', JSON.stringify(result))
    return result
}
