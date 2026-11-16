import { buildComaxParams, buildComaxPromotionParams, buildSalesPriceArray } from './utils.js'
import { fetchComax, fetchComaxBalance, fetchComaxPromotions, fetchComaxStream, fetchComaxSalesWindowStream } from './client.js'
import { parseXml, normalizeArray, parseXmlFile, splitItemBlocks, parseItemBlock, splitExtendedBalanceBlocks, parseExtendedBalanceBlock } from './parser.js'
import { mapItem, mapPromotion, mapBalance, mapSalesWindowItem } from './mapper.js'
import { writeDeliveryDocument } from './deliveryDocs.js'
import { getDeliveryDocument, findDeliveryDocByReference } from './deliveryFetch.js'
import { fetchAndStoreDeliveryDoc, ensureDeliveryDoc } from './deliverySync.js'
import { resolveDeliveryConfig } from './resolveDeliveryConfig.js'

// Super-department 12 is excluded from the catalog.
// includeZeroPrice (the catalog feeds and the buying-price import): a zero-price
// item must survive so a removed price clears the stored value instead of silently
// keeping it, and so an item Comax carries without a price becomes a row that the
// catalog report can show.
// includeInternal (trailing-item lookup): deposit products live in super
// department 12 and must be readable even though they are never catalog items.
function keepProduct(product, includeZeroPrice, includeInternal) {
    if (!includeInternal && product.superDepartmentCode == 12) return false
    if (!includeZeroPrice && !(product.price > 0)) return false
    return true
}

async function getProducts({ DL, includeZeroPrice, includeInternal, skipLog, silent, timeoutMs, ...options }) {
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
    const products = items.map(item => mapItem(item, options)).filter(p => keepProduct(p, includeZeroPrice, includeInternal))

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
async function* streamProducts({ DL, includeZeroPrice, includeInternal, skipLog, silent, timeoutMs, stats, ...options }) {
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

        const product = mapItem(item, options)
        if (!keepProduct(product, includeZeroPrice, includeInternal)) continue

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

/**
 * One item by its Comax ID, including super-department 12 items.
 *
 * Used to resolve a product's TrailingItem (the deposit product) into its
 * price and barcode. Deposit products are deliberately excluded from the
 * catalog feeds, so this is the only way to read them.
 */
async function getItemById({ DL, itemId, includeInternal = true, includeZeroPrice = true, ...options }) {
    // Drain the (single-item) response instead of returning from the middle of
    // the generator: that would skip its completion log and leave the request
    // log hanging without a success/error entry.
    let found = null
    for await (const product of streamProducts({ ...options, DL, itemId, includeInternal, includeZeroPrice })) {
        if (!found) found = product
    }
    return found
}

/**
 * One store's in-stock feed.
 *
 * `HasInventory=1` turns the catalog call into "what this store can sell now".
 * The response is well under the 17,000-item cap, so it is complete, and
 * `LastUpdatedFromDate=` stays empty on purpose: this is a snapshot, not a
 * delta. `SalesPriceArray` adds the delivery/buying price row to the same
 * response.
 *
 * No `SelByPriceList`, and `includeZeroPrice` is forced on: that filter selects
 * ITEMS by price-list membership, so Comax answers nothing at all for an item
 * with no entry in 1069 or 255 — the counter items that sell unpriced (43001 בקר
 * טחון מחפוד, 43209 צלעות מחפוד and their block). Those items were invisible to
 * the import, so a store could sell them for a month and neither comax_products
 * nor the catalog report ever heard of them. The price rows come from
 * `SalesPriceArray` on its own — measured on live Comax: removing the filter
 * leaves every price of a priced item byte-identical (retail and the 255 buying
 * price), and only adds the items that have neither. A row with no price is what
 * the status ladder archives, so an unpriced item can never reach the site.
 */
async function* streamStoreProducts({ DL, storeId, priceListId, ...options }) {
    const listId = priceListId || process.env.COMAX_PRICELIST_ID
    yield* streamProducts({
        ...options,
        DL,
        storeId,
        priceListId: listId,
        salesPriceArray: options.salesPriceArray || buildSalesPriceArray({ priceListId: listId }),
        hasInventory: true,
        includeZeroPrice: true
    })
}

/**
 * One fresh (not stock-managed) department.
 *
 * Fresh counters — produce, butcher, fish, bakery, deli — are not tracked by
 * Comax stock, so `HasInventory=1` excludes them (dept 13: 2 items of 1,588).
 * `DepartmentID` takes exactly one code (comma/pipe/semicolon all return 0),
 * and the response is store-independent, hence one call per department.
 *
 * Same price-list rule as the store feed, and it matters most here: the counter
 * items with no entry in 1069/255 (the מחפוד scale codes) are fresh-department
 * items, so this is the feed that has to see them.
 */
async function* streamDepartmentProducts({ DL, departmentId, storeId, priceListId, ...options }) {
    const listId = priceListId || process.env.COMAX_PRICELIST_ID
    yield* streamProducts({
        ...options,
        DL,
        departmentId,
        storeId: storeId || process.env.COMAX_STORE_ID,
        priceListId: listId,
        salesPriceArray: options.salesPriceArray || buildSalesPriceArray({ priceListId: listId }),
        includeZeroPrice: true
    })
}

/**
 * One store's recently-sold feed: barcode, department and last sale date.
 *
 * This is a different Comax binding (`Get_AllItemsBalanceBySearch_Extended`,
 * SOAP POST, `NumDaysSold` in the query). It answers "did this sell here in
 * the last N days" for the whole store in one call — Comax applies the window
 * before returning, so it must be given the widest configured window; the
 * per-department cut is made from each row's `LastSaleDate`.
 *
 * It carries no `SalesPrice` rows, so it must never be used as a catalog feed.
 */
async function* streamSalesWindow({ DL, storeId, days, priceListId, timeoutMs, stats }) {
    const source = await fetchComaxSalesWindowStream({
        days,
        storeId,
        priceListId: priceListId || process.env.COMAX_PRICELIST_ID,
        timeoutMs
    }, { DL })

    let count = 0
    let blocks = 0
    let unparsed = 0

    for await (const block of splitExtendedBalanceBlocks(source)) {
        blocks++
        let item
        try {
            item = parseExtendedBalanceBlock(block)
        } catch (e) {
            unparsed++
            console.warn(`[Comax] Failed to parse sales-window block: ${e?.message || e}`)
            continue
        }
        if (!item) continue

        const row = mapSalesWindowItem(item)
        if (!row.barcode) continue

        count++
        yield row
    }

    if (stats) {
        stats.blocks = blocks
        stats.kept = count
        stats.unparsed = unparsed
    }
    if (count === 0) console.log(`[Comax] No sales in the last ${days} day(s) for store ${storeId}`)
    else console.log(`[Comax] Fetched ${count} sold item(s) for store ${storeId} (${days}d)`)
}

async function getProductsFromFile({ inputFile }) {
    const items = await parseXmlFile(inputFile)
    const products = items.map(item => mapItem(item)).filter(p => keepProduct(p, false))
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
    getItemById: options => getItemById({ ...options, DL }),
    streamProducts: options => streamProducts({ ...options, DL }),
    streamStoreProducts: options => streamStoreProducts({ ...options, DL }),
    streamDepartmentProducts: options => streamDepartmentProducts({ ...options, DL }),
    streamSalesWindow: options => streamSalesWindow({ ...options, DL }),
    getProductsFromFile,
    getPromotions: options => getPromotions({ ...options, DL }),
    getBalance: options => getBalance({ ...options, DL }),
    writeDeliveryDocument: (order, opts) => writeDeliveryDocument({ DL, order, opts }),
    getDeliveryDocument: (args) => getDeliveryDocument({ DL, ...args }),
    findDeliveryDocByReference: (args) => findDeliveryDocByReference({ DL, ...args }),
    syncDeliveryDoc: (docNumber) => fetchAndStoreDeliveryDoc({ DL, docNumber }),
    ensureDeliveryDoc: (args) => ensureDeliveryDoc({ DL, ...args }),
    resolveDeliveryConfig: storeId => resolveDeliveryConfig(DL, storeId)
})
export default comax
