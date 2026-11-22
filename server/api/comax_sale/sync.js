import { updateSalesAndProducts } from '../sale/sync.js'
import { findInflatedBarcode } from '#server/utils/data/validateSalePrice.js'
import { readAliasIndex } from '#server/services/productFamily.js'
const IGNORE_PROMO_TYPES = [18, 19, 5, 6, 9, 10]

const round2 = n => Math.round(Number(n) * 100) / 100

/**
 * The deposit total a Comax sale total is missing.
 *
 * Comax's `Total` for a promotion excludes the trailing items (deposits) of
 * the products it covers: "3 ב-20" on 0.30-deposit bottles arrives as 19.10.
 * A bundle may mix deposit and non-deposit items, so the per-unit deposit is
 * the cheapest eligible one — the same order the bundle consumes.
 */
export function trailingTotalForSale({ barcodes, amount, barcodeToDepositMap }) {
    const qty = Number(amount) || 0
    if (!qty || !Array.isArray(barcodes) || !barcodes.length || !barcodeToDepositMap) return 0

    let perUnit = null
    for (const barcode of barcodes) {
        const deposit = Number(barcodeToDepositMap.get(barcode)) || 0
        if (perUnit === null || deposit < perUnit) perUnit = deposit
    }
    if (!perUnit) return 0
    return round2(perUnit * qty)
}

/**
 * Model IDs a Comax sale is defined on (`itemsModel`). A promotion can point at
 * a model instead of listing every barcode, so the sync expands it to all
 * comax_products whose `models.id` matches.
 */
export function modelKodsForSale(cs) {
    const kods = []
    for (const ref of (cs.itemsModel || [])) {
        if (ref?.SwNotActive) continue
        const kod = ref?.Kod != null ? String(ref.Kod) : ''
        if (kod && kod !== '0') kods.push(kod)
    }
    return [...new Set(kods)]
}

export function modelBarcodesForSale(cs, modelKodToBarcodes) {
    const barcodes = []
    for (const kod of modelKodsForSale(cs)) {
        for (const barcode of modelKodToBarcodes?.get(kod) || []) barcodes.push(barcode)
    }
    return barcodes
}

/**
 * modelKod -> all product barcodes carrying that model in `models.id`.
 * Products belong to a model, so one barcode may appear under several models;
 * each model's list is deduplicated.
 */
export function buildModelKodToBarcodes(products, modelKods) {
    const map = new Map()
    for (const product of (products || [])) {
        if (!product?.barcode) continue
        for (const model of (product.models || [])) {
            const id = model?.id != null ? String(model.id) : ''
            if (!id || !modelKods?.has(id)) continue
            const list = map.get(id) || []
            if (!list.includes(product.barcode)) list.push(product.barcode)
            map.set(id, list)
        }
    }
    return map
}

// Lowest regular price across all domains — a global sale must discount every domain.
function minAcrossDomains(prices) {
    if (!Array.isArray(prices)) return undefined
    let min
    for (const p of prices) {
        const v = Number(p?.price)
        if (!Number.isFinite(v)) continue
        if (min === undefined || v < min) min = v
    }
    return min
}

function deduplicateKey(cs) {
    const items = (cs.items || []).map(i => String(i.Kod || i)).sort()
    const getItems = (cs.getItems || []).map(i => String(i.Kod || i)).sort()
    const itemsModel = modelKodsForSale(cs).sort()
    return JSON.stringify({
        items,
        getItems,
        itemsModel,
        getGiftItem: cs.getGiftItem ? String(cs.getGiftItem) : null,
        quantity: cs.quantity,
        minQty: cs.minQty,
        total: cs.total,
        getTotal: cs.getTotal,
        promotionType: cs.promotionType,
        getCmt: cs.getCmt,
        getDiscountPercent: cs.getDiscountPercent,
        getDiscountTotal: cs.getDiscountTotal,
        swAllItems: cs.swAllItems,
        maxQty: cs.maxQty
    })
}

function deduplicateSales(comaxSales) {
    const byKey = new Map()
    const deduplicateSaleIds = new Set()
    for (const cs of comaxSales) {
        const key = deduplicateKey(cs)
        const existing = byKey.get(key)
        if (!existing) {
            byKey.set(key, cs)
            continue
        }
        const existingDate = new Date(existing.fromDate).getTime()
        const candidateDate = new Date(cs.fromDate).getTime()
        const newerSale = candidateDate > existingDate ||
            (candidateDate === existingDate && String(cs.comaxId) > String(existing.comaxId))
        if (newerSale) {
            deduplicateSaleIds.add(existing.comaxId)
            byKey.set(key, cs)
        }
    }
    return { uniqueComaxSales: Array.from(byKey.values()), deduplicateSaleIds }
}

function buildSale(cs, kodToBarcodeMap, activeBarcodesSet, barcodeToPriceMap, barcodeToDepositMap, modelKodToBarcodes, DL, stats) {
    if (IGNORE_PROMO_TYPES.includes(cs.promotionType)) {
        return null
    }
    const { KINDS, TYPES, STATUS } = DL.Sale.constants
    const itemBarcodes = (cs.items || [])
        .filter(i => !i.SwNotActive)
        .map(i => kodToBarcodeMap.get(String(i.Kod)) || String(i.Kod))
    // A sale can target a whole model ("itemsModel") instead of listing every
    // variant. Expand it to every comax_products row carrying that model.
    // Unlike explicitly listed items, model barcodes are kept regardless of the
    // product's current status: the sale must still be ready if the product is
    // activated later, without another sales sync.
    const modelBarcodes = modelBarcodesForSale(cs, modelKodToBarcodes)

    const rawReceiveBarcodes = (cs.getItems || [])
        .filter(i => !i.SwNotActive)
        .map(i => kodToBarcodeMap.get(String(i.Kod)) || String(i.Kod))

    if (cs.getGiftItem) {
        const giftBarcode = kodToBarcodeMap.get(String(cs.getGiftItem)) || String(cs.getGiftItem)
        if (!rawReceiveBarcodes.includes(giftBarcode)) {
            rawReceiveBarcodes.push(giftBarcode)
        }
    }

    let kind = KINDS.PRICE
    let type = cs.swAllItems ? TYPES.CART : TYPES.PRODUCT
    let amount = cs.quantity || cs.minQty || 1
    let price = cs.total || cs.getTotal || undefined
    let percent = cs.getDiscountPercent || undefined

    let receiveOverride = null

    // Specific PromotionType logic:
    // 1 – כמות בסכום
    // 5 – קנה בסכום הוסף קבל
    // 6 – קנה בכמות הוסף קבל
    // 9 – שני בחצי מחיר
    // 10 – קנה בכמות קבל(אותו הפריט)
    // 18 – הנחת סוף חשבון (ignored)
    switch (cs.promotionType) {
        case 1:
            kind = percent > 0 ? KINDS.PERCENT : KINDS.PRICE
            amount = cs.quantity || cs.minQty || 1
            price = cs.total
            break
        case 5:
            if (rawReceiveBarcodes.length > 0) {
                kind = KINDS.RECEIVE_PRICE
                price = cs.total
            } else {
                return null
            }
            break
        case 6:
            amount = cs.quantity || cs.minQty || 1
            if (rawReceiveBarcodes.length > 0) {
                kind = KINDS.RECEIVE_AMOUNT
            } else {
                return null
            }
            break
        case 9:
            amount = cs.quantity || 1
            kind = KINDS.RECEIVE_AMOUNT
            if (rawReceiveBarcodes.length === 0) {
                rawReceiveBarcodes.push(...validBarcodes)
            }
            receiveOverride = {
                variety: false,
                barcodes: rawReceiveBarcodes.length > 0 ? rawReceiveBarcodes : validBarcodes,
                amount: cs.getCmt || 1,
                type: KINDS.PERCENT,
                percent: cs.getDiscountPercent || 50
            }
            break
        case 10:
            amount = cs.quantity || cs.minQty || 1
            kind = KINDS.RECEIVE_AMOUNT
            if (rawReceiveBarcodes.length === 0) {
                rawReceiveBarcodes.push(...validBarcodes)
            }
            break
        default:
            return null
    }

    const now = Date.now()
    const start = new Date(cs.fromDate || Date.now())
    const end = new Date(cs.toDate || now + 7 * 24 * 60 * 60 * 1000)
    end.setHours(23, 59)
    if (start.getTime() > end.getTime())
        return null

    let status = STATUS.ACTIVE
    if (!cs.swActive) {
        status = STATUS.CANCELED
    } else if (end.getTime() < now) {
        status = STATUS.DONE
    } else if (start.getTime() > now) {
        status = STATUS.PENDING
    }

    const saleName = cs.name || `מבצע ${cs.comaxId}`
    const displayName = cs.name || `מבצע ${cs.comaxId}`

    const validBarcodes = [...new Set([
        ...itemBarcodes.filter(b => activeBarcodesSet.has(b)),
        ...modelBarcodes
    ])]

    if (validBarcodes.length === 0) {
        return null
    }

    // Comax totals exclude deposits; charge them through the sale price so a
    // "3 ב-20" bundle costs 20.00 and not 19.10.
    // Deposit math stays on the currently sellable barcodes: model expansion
    // deliberately keeps inactive products in `barcodes` for later, and their
    // missing/zero deposit must not zero out the price for today's customers.
    const comaxPrice = price
    let trailingTotal = 0
    if (kind === KINDS.PRICE && price != null) {
        const activeForDeposit = validBarcodes.filter(b => activeBarcodesSet.has(b))
        trailingTotal = trailingTotalForSale({
            barcodes: activeForDeposit.length ? activeForDeposit : validBarcodes,
            amount,
            barcodeToDepositMap
        })
        if (trailingTotal > 0) price = round2(price + trailingTotal)
    }

    // Block inflated kind=price sales: sale price must be strictly lower than
    // regular total (min domain price x amount) for every barcode — skip otherwise
    if (kind === KINDS.PRICE && price != null && barcodeToPriceMap) {
        const inflated = findInflatedBarcode(
            { kind, price, amount, barcodes: validBarcodes },
            barcodeToPriceMap,
            KINDS.PRICE
        )
        if (inflated) {
            if (stats) stats.skippedInflated = (stats.skippedInflated || 0) + 1
            console.log(`[Comax Sales Sync] Skipping inflated sale ${cs.comaxId}: price ${price} >= regular total for barcode ${inflated}`)
            return null
        }
    }

    const saleDoc = {
        id: cs.comaxId,
        name: saleName,
        displayName: displayName,
        type,
        kind,
        status,
        start,
        end,
        amount,
        limit: cs.maxQty || 0,
        price,
        comaxPrice,
        trailingTotal: trailingTotal || undefined,
        percent,
        barcodes: validBarcodes,
        description: cs.remarkForPrint || undefined,
        createdBy: 'Comax Sync'
    }

    if (receiveOverride) {
        saleDoc.receive = receiveOverride
    } else if (rawReceiveBarcodes.length > 0) {
        saleDoc.receive = {
            variety: false,
            barcodes: rawReceiveBarcodes,
            amount: cs.getCmt || 1,
            type: cs.getDiscountPercent > 0 ? KINDS.PERCENT : KINDS.PRICE,
            percent: cs.getDiscountPercent || (kind === KINDS.RECEIVE_AMOUNT ? 100 : undefined),
            price: cs.getDiscountTotal || undefined
        }
    }

    // Check receive.barcodes for receive-amount and receive-price sales
    if (saleDoc.kind === KINDS.RECEIVE_AMOUNT || saleDoc.kind === KINDS.RECEIVE_PRICE) {
        const receiveBarcodesList = saleDoc.receive?.barcodes || []
        const validReceiveBarcodes = receiveBarcodesList.filter(b => activeBarcodesSet.has(b))

        if (validReceiveBarcodes.length === 0) {
            return null
        }
        saleDoc.receive.barcodes = validReceiveBarcodes
    }

    return saleDoc
}

export default async function syncComaxSales(payload, { DL }) {
    const comaxSales = await DL.ComaxSale.read(
        { swActive: true, promotionType: { $nin: IGNORE_PROMO_TYPES } },
        {
            _id: 0,
            name: 1,
            comaxId: 1,
            promotionType: 1,
            items: 1,
            quantity: 1,
            total: 1,
            fromDate: 1,
            toDate: 1,
            minQty: 1,
            maxQty: 1,
            remarkForPrint: 1,
            getDiscountTotal: 1,
            getDiscountPercent: 1,
            getGiftItem: 1,
            getItems: 1,
            itemsModel: 1,
            getTotal: 1,
            getCmt: 1,
            swActive: 1,
            swAllItems: 1
        },
        { limit: 0 }
    )

    if (comaxSales.length === 0) {
        console.log('[Comax Sales Sync] No sales to sync')
        await updateSalesAndProducts({ DL })
        return { synced: 0, updated: 0, created: 0 }
    }

    const { uniqueComaxSales, deduplicateSaleIds } = deduplicateSales(comaxSales)
    if (uniqueComaxSales.length !== comaxSales.length) {
        console.log(`[Comax Sales Sync] Deduplicated ${deduplicateSaleIds.size} duplicate sales`)
    }

    // Get active product barcodes + regular prices (min across domains)
    const activeProducts = await DL.Product.read(
        { status: DL.Product.constants.STATUS.ACTIVE },
        { _id: 0, barcode: 1, prices: 1 },
        { limit: 0 }
    )
    const activeBarcodesSet = new Set((activeProducts || []).map(p => p.barcode))
    const barcodeToPriceMap = new Map(
        (activeProducts || []).map(p => [p.barcode, minAcrossDomains(p?.prices)])
    )

    // Comax runs a promotion on one barcode; the catalog sells one product that
    // may be scanned under several (`scannableBarcodes`). A sale found on an
    // alias belongs to the product that owns that alias, so every barcode a
    // sale resolves to is normalized to its owner before it is matched against
    // the catalog. Without this a promo under a retired code would silently
    // apply to nothing.
    const { ownerByAlias } = await readAliasIndex(DL)
    const ownerOf = barcode => (barcode && ownerByAlias.get(barcode)) || barcode

    // Collect all item Kods for barcode resolution, plus the model Kods some
    // sales are defined on. Model Kods are resolved through
    // comax_products.models.id, not through the product barcode.
    const kodsSet = new Set()
    const modelKodsSet = new Set()
    for (const cs of uniqueComaxSales) {
        if (cs.getGiftItem) kodsSet.add(String(cs.getGiftItem))
        for (const item of (cs.items || [])) {
            if (item.Kod) kodsSet.add(String(item.Kod))
        }
        for (const item of (cs.getItems || [])) {
            if (item.Kod) kodsSet.add(String(item.Kod))
        }
        for (const kod of modelKodsForSale(cs)) modelKodsSet.add(kod)
    }

    const kodArray = Array.from(kodsSet)
    const modelArray = Array.from(modelKodsSet)
    let kodToBarcodeMap = new Map()
    const barcodeToDepositMap = new Map()
    const modelKodToBarcodes = new Map()

    if (kodArray.length > 0 || modelArray.length > 0) {
        const matchingProducts = await DL.ComaxProduct.read(
            {
                $or: [
                    { comaxId: { $in: kodArray } },
                    { barcode: { $in: kodArray } },
                    { 'models.id': { $in: modelArray } }
                ]
            },
            { barcode: 1, comaxId: 1, trailingPrice: 1, models: 1 },
            { limit: 0 }
        )

        // Comax knows barcodes, the catalog knows products: an alias row has no
        // product doc of its own (the import folded it into its owner), so the
        // maps are keyed by the barcode the sale can be matched and priced on —
        // the owner's. The deposit keeps the cheapest of the family, which is the
        // same "cheapest eligible item of the bundle" rule as before.
        for (const p of matchingProducts) {
            if (!p.barcode) continue
            const barcode = ownerOf(p.barcode)
            if (p.comaxId) kodToBarcodeMap.set(String(p.comaxId), barcode)
            kodToBarcodeMap.set(String(p.barcode), barcode)

            const deposit = Number(p.trailingPrice)
            if (deposit > 0) {
                const known = Number(barcodeToDepositMap.get(barcode)) || 0
                if (!known || deposit < known) barcodeToDepositMap.set(barcode, deposit)
            }
        }

        for (const [kod, barcodes] of buildModelKodToBarcodes(matchingProducts, modelKodsSet)) {
            modelKodToBarcodes.set(kod, [...new Set(barcodes.map(ownerOf))])
        }
    }

    const stats = { skippedInflated: 0 }
    const salesToSync = uniqueComaxSales
        .map(cs => buildSale(cs, kodToBarcodeMap, activeBarcodesSet, barcodeToPriceMap, barcodeToDepositMap, modelKodToBarcodes, DL, stats))
        .filter(Boolean)

    if (stats.skippedInflated > 0) {
        console.log(`[Comax Sales Sync] Skipped ${stats.skippedInflated} inflated sales (price >= regular total)`)
    }

    if (salesToSync.length === 0) {
        console.log('[Comax Sales Sync] No valid sales matching active products to sync')
        await updateSalesAndProducts({ DL })
        return { synced: 0, updated: 0, created: 0, skippedInflated: stats.skippedInflated }
    }

    const result = await DL.Sale.bulkWrite({
        docs: salesToSync
    })

    const syncedIds = uniqueComaxSales.map(s => s.comaxId)
    await DL.ComaxSale.update(
        { comaxId: { $in: syncedIds } },
        { syncedAt: new Date() }
    )

    const saleResults = await updateSalesAndProducts({ DL })

    console.log(`[Comax Sales Sync]\nCreated ${result.upsertedCount}\nupdated ${result.modifiedCount}\nStatus updates: ${JSON.stringify(saleResults, null, 2)}`)

    return {
        synced: salesToSync.length,
        created: result.upsertedCount,
        updated: result.modifiedCount,
        skippedInflated: stats.skippedInflated,
        saleUpdates: saleResults
    }
}

syncComaxSales.config = {
    required: [],
    permissions: ['sale:update'],
    auth: 'required',
    preventMultiple: true
}
