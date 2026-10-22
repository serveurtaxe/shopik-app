import { buildComaxParams, buildComaxPromotionParams } from './utils.js'
import { fetchComax, fetchComaxBalance, fetchComaxPromotions, fetchComaxStream } from './client.js'
import { parseXml, normalizeArray, parseXmlFile, splitItemBlocks, parseItemBlock } from './parser.js'
import { mapItem, mapPromotion, mapBalance } from './mapper.js'
import { writeDeliveryDocument } from './deliveryDocs.js'
import { getDeliveryDocument } from './deliveryFetch.js'
import { fetchAndStoreDeliveryDoc } from './deliverySync.js'
import { resolveDeliveryConfig } from './resolveDeliveryConfig.js'

// Super-department 12 is excluded from the catalog.
// includeZeroPrice (buying-price import): zero-price items must survive so a
// removed price can clear the stored value instead of silently keeping it.
function keepProduct(product, includeZeroPrice) {
    if (product.superDepartmentCode == 12) return false
    if (!includeZeroPrice && !(product.price > 0)) return false
    return true
}

async function getProducts({ DL, includeZeroPrice, skipLog, silent, timeoutMs, ...options }) {
    // 1. Build query params
    const params = buildComaxParams(options)

    // 2. Fetch XML
    const xml = await fetchComax({ params, timeoutMs, skipLog }, { DL })

    // 3. Parse XML
    const parsed = parseXml(xml)

    // 4. Extract products array from SOAP envelope
    const items = normalizeArray(parsed?.ArrayOfClsItems?.ClsItems)

    if (items.length === 0) {
        if (!silent) console.log(`[Comax] No products returned`)
        return []
    }

    // 5. Map to clean objects
    const products = items.map(mapItem).filter(p => keepProduct(p, includeZeroPrice))

    if (!silent) console.log(`[Comax] Fetched ${products.length} products`)

    return products
}

/**
 * Stream the catalog — one item in memory at a time.
 *
 * `getProducts` holds the entire response as a string, then as a parsed
 * object tree, then as a mapped array. A mass price update makes the Comax
 * delta the whole catalog (hundreds of MB) and that exhausted the container
 * memory limit. This parses one `<ClsItems>` block at a time and yields
 * mapped products, so peak memory is one item plus the caller's batch.
 *
 * Pass a `stats` object to learn how many item blocks the response held and
 * how many failed to parse — an empty delta and a changed response format
 * look the same from the outside.
 */
async function* streamProducts({ DL, includeZeroPrice, skipLog, silent, timeoutMs, stats, ...options }) {
    const params = buildComaxParams(options)
    const source = await fetchComaxStream({ params, timeoutMs, skipLog }, { DL })

    let count = 0
    let blocks = 0
    let unparsed = 0

    for await (const block of splitItemBlocks(source)) {
        blocks++
        let item
        try {
            item = parseItemBlock(block)
        } catch (e) {
            unparsed++
            if (!silent) console.warn(`[Comax] Failed to parse item block: ${e?.message || e}`)
            continue
        }
        if (!item) continue

        const product = mapItem(item)
        if (!keepProduct(product, includeZeroPrice)) continue

        count++
        yield product
    }

    if (stats) {
        stats.blocks = blocks
        stats.kept = count
        stats.unparsed = unparsed
    }
    if (!silent) console.log(`[Comax] Fetched ${count} products${unparsed ? ` (${unparsed} unparseable)` : ''}`)
}

async function getProductsFromFile({ inputFile }) {
    const items = await parseXmlFile(inputFile)
    const products = items.map(mapItem).filter(p => keepProduct(p, false))
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
    streamProducts: options => streamProducts({ ...options, DL }),
    getProductsFromFile,
    getPromotions: options => getPromotions({ ...options, DL }),
    getBalance: options => getBalance({ ...options, DL }),
    writeDeliveryDocument: (order, opts) => writeDeliveryDocument({ DL, order, opts }),
    getDeliveryDocument: (args) => getDeliveryDocument({ DL, ...args }),
    syncDeliveryDoc: (docNumber) => fetchAndStoreDeliveryDoc({ DL, docNumber }),
    resolveDeliveryConfig: storeId => resolveDeliveryConfig(DL, storeId)
})
export default comax
