import { calcOrderSum } from '../../common/functions/calcOrder/index.js'

let seq = 0
const nextId = (prefix) => `${prefix}${++seq}`

// Minimal cart product shape as normalizeProduct() expects it:
// amount = ordered qty, finalAmount = packed qty (pick time; undefined at checkout).
export function makeProduct(over = {}) {
    const barcode = over.barcode ?? 'B1'
    const saleIds = over.saleIds ?? ['S1']
    return {
        id: over.id ?? nextId('p'),
        name: over.name ?? 'prod',
        barcode,
        amount: over.amount ?? 1,
        ...(over.finalAmount !== undefined ? { finalAmount: over.finalAmount } : {}),
        price: over.price ?? 15,
        orderPrice: over.orderPrice ?? over.price ?? 15,
        saleIds,
        unit: { type: 'item' },
        ...over,
    }
}

// Minimal sale shape as transformSales() expects it (keyed by id in salesMap).
export function makeSale(over = {}) {
    const id = over.id ?? 'S1'
    return {
        id,
        kind: 'amount',
        amount: 3,
        price: 10,
        barcodes: ['B1'],
        limit: undefined,
        start: new Date('2020-01-01'),
        end: new Date('2030-01-01'),
        name: 'test sale',
        displayName: 'test',
        code: 'T1',
        ...over,
    }
}

export const salesMap = (...sales) => Object.fromEntries(sales.map((s) => [s.id, s]))

export function calc(cart, sales) {
    return calcOrderSum({ cart, sales })
}

export const total = (result) => result.totals.sum

// Per-product sale/regular split: { [productId]: { sale, regular } }
export function splitByProduct(result) {
    const out = {}
    for (const p of result.processedCart) {
        let sale = 0
        let regular = 0
        for (const d of p.pricesDistribution || []) {
            if (d.saleId) sale += d.sum
            else regular += d.sum
        }
        out[p.id] = { sale: Math.round(sale * 100) / 100, regular: Math.round(regular * 100) / 100 }
    }
    return out
}
