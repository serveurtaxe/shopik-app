import { buildComaxParams, buildComaxPromotionParams } from './utils.js'
import { fetchComax, fetchComaxBalance, fetchComaxPromotions } from './client.js'
import { parseXml, normalizeArray, parseXmlFile } from './parser.js'
import { mapItem, mapPromotion, mapBalance } from './mapper.js'
import { writeDeliveryDocument } from './deliveryDocs.js'
import { getDeliveryDocument } from './deliveryFetch.js'
import { fetchAndStoreDeliveryDoc } from './deliverySync.js'
import { resolveDeliveryConfig } from './resolveDeliveryConfig.js'

async function getProducts({ DL, ...options }) {
    // 1. Build query params
    const params = buildComaxParams(options)

    // 2. Fetch XML
    const xml = await fetchComax({ params }, { DL })

    // 3. Parse XML
    const parsed = parseXml(xml)

    // 4. Extract products array from SOAP envelope
    const items = normalizeArray(parsed?.ArrayOfClsItems?.ClsItems)

    if (items.length === 0) {
        console.log(`[Comax] No products returned`)
        return []
    }

    // 5. Map to clean objects
    const products = items.map(mapItem).filter(p => p.superDepartmentCode != 12 && p.price > 0)

    console.log(`[Comax] Fetched ${products.length} products`)

    return products
}

async function getProductsFromFile({ inputFile }) {
    const items = await parseXmlFile(inputFile)
    const products = items.map(mapItem).filter(p => p.superDepartmentCode != 12 && p.price > 0)
    console.log(`[Comax] Fetched ${products.length} products from file`)
    return products

}

async function getBalance({ DL, ...options }) {
    const params = buildComaxParams(options)
    params.ChangesAfter = '01/01/2025'
    const xml = await fetchComaxBalance({ params }, { DL })
    const parsed = parseXml(xml)
    const items = normalizeArray(
        parsed?.ArrayOfClsItemsBalance?.ClsItemsBalance
        ?? parsed?.['soap:Envelope']?.['soap:Body']?.Get_AllItemsBalanceBySearchResponse?.Get_AllItemsBalanceBySearchResult?.ClsItemsBalance
    )
    if (items.length === 0) {
        console.log('[Comax] No balances returned')
        return []
    }
    const balances = items.map(mapBalance).filter(b => b.barcode)
    console.log(`[Comax] Fetched ${balances.length} balances`)
    return balances
}

async function getPromotions({ DL, ...options }) {
    const params = buildComaxPromotionParams(options)
    const rawPromotions = await fetchComaxPromotions({ params }, { DL })
    if (!rawPromotions || rawPromotions.length === 0) {
        console.log('[Comax] No promotions returned')
        return []
    }
    const promotions = rawPromotions.map(mapPromotion)
    console.log(`[Comax] Fetched ${promotions.length} promotions`)
    return promotions
}

const comax = ({ DL }) => ({
    getProducts: options => getProducts({ ...options, DL }),
    getProductsFromFile,
    getPromotions: options => getPromotions({ ...options, DL }),
    getBalance: options => getBalance({ ...options, DL }),
    writeDeliveryDocument: (order, opts) => writeDeliveryDocument({ DL, order, opts }),
    getDeliveryDocument: (args) => getDeliveryDocument({ DL, ...args }),
    syncDeliveryDoc: (docNumber) => fetchAndStoreDeliveryDoc({ DL, docNumber }),
    resolveDeliveryConfig: storeId => resolveDeliveryConfig(DL, storeId)
})
export default comax