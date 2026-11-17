import crypto from 'crypto'
import log from '#server/utils/log.js'
import { scanDel } from '#server/utils/redisSafe.js'

// Re-exported: page-cache invalidation callers (menu, category map, scripts)
// import it from here.
export { scanDel }

export const DISPLAY_CACHE_TTL_SEC = 3600
export const DEFAULT_BASE_LIMIT = 10
export const DEFAULT_PREVIEW_LIMIT = 10

const BASE_LIMIT_KEY = 'display.carouselBaseLimit'
const PREVIEW_LIMIT_KEY = 'display.carouselPreviewLimit'

// Curated carousel sort options (admin select) mapped to real sorts server-side.
const SORTS = {
    default: null, // → DL.Product.Model.defaultSort
    newest: { createdAt: -1 },
    popular: { totalSalesUnits: -1 }
}

export function displayCacheKey(domainId, path, mode) {
    return `display:${domainId}:${path}:${mode}`
}

export async function getDisplayLimit(DL, domainId, settingKey, fallback) {
    try {
        const doc = await DL.Setting.readOne(
            { key: settingKey, domainId },
            { _id: 0, value: 1 }
        )
        const n = Number(doc?.value)
        if (Number.isFinite(n) && n > 0) return Math.floor(n)
    } catch { }
    return fallback
}

export const getBaseLimit = (DL, domainId) =>
    getDisplayLimit(DL, domainId, BASE_LIMIT_KEY, DEFAULT_BASE_LIMIT)

export const getPreviewLimit = (DL, domainId) =>
    getDisplayLimit(DL, domainId, PREVIEW_LIMIT_KEY, DEFAULT_PREVIEW_LIMIT)

// Invalidate every cached page a block can appear on.
// Path placement → exact page. Category placement → the category page and all
// pages beneath it (glob on the /products/<categoryPath> prefix).
export async function invalidateDisplayCache(DL, domainId, block) {
    try {
        const redis = DL.redis
        if (!redis || !domainId || !block?.placement) return 0
        const { type, path, categoryId } = block.placement
        if (type === 'path' && path) {
            return await scanDel(redis, `display:${domainId}:${path}:*`)
        }
        if (type === 'category' && categoryId) {
            const category = await DL.Category.readOne(
                { id: categoryId },
                { _id: 0, path: 1 }
            ).catch(() => null)
            const prefix = category?.path
                ? `/products/${category.path}`
                : '/products'
            return await scanDel(redis, `display:${domainId}:${prefix}*`)
        }
    } catch (e) {
        log.warn('[Display] cache invalidation failed:', e?.message || e)
    }
    return 0
}

// Build the product filter for a carousel block. Returns null when the filter
// references data that no longer exists (unknown category / no active sales) —
// callers must treat null as "no products" rather than falling back to
// unfiltered, which would dump the whole catalog into a carousel.
export async function resolveCarouselFilter(DL, carousel, domainId) {
    const f = carousel?.filter || {}
    const filter = {
        status: DL.Product.constants.STATUS.ACTIVE,
        'prices.domainId': domainId
    }
    if (f.categoryId) {
        const category = await DL.Category.readOne(
            { id: f.categoryId },
            { _id: 0, id: 1 }
        )
        if (!category) return null
        filter['category.pathIds'] = category.id
    }
    if (f.onSale) {
        const activeSaleIds = await DL.Sale.Model.distinct('id', { status: DL.Sale.constants.STATUS.ACTIVE })
        if (activeSaleIds.length === 0) return null
        filter.saleIds = { $in: activeSaleIds }
    }
    if (Array.isArray(f.barcodes) && f.barcodes.length) {
        filter.barcode = { $in: f.barcodes.map(String) }
    }
    return { filter, search: f.search?.trim() || '' }
}

export function resolveCarouselSort(DL, carousel) {
    const sort = SORTS[carousel?.sort]
    if (sort) return sort
    if (carousel?.sort && typeof carousel.sort === 'object') {
        // Allowlisted raw sorts only — never trust arbitrary client sort objects.
        const allowed = ['sortOrder', 'totalSalesUnits', 'createdAt', 'name']
        const clean = {}
        for (const [k, v] of Object.entries(carousel.sort)) {
            if (allowed.includes(k) && (v === 1 || v === -1)) clean[k] = v
        }
        if (Object.keys(clean).length) return clean
    }
    return DL.Product.Model.defaultSort
}

export function carouselSelect(DL) {
    // storeIds always selected: filter/annotate modes derive per-store views
    // from the cached base without an extra query.
    return { ...(DL.Product.defaultSelect || {}), storeIds: 1 }
}

export async function collectSales(DL, products) {
    const saleIdSet = new Set()
    for (const p of products || []) {
        if (Array.isArray(p?.saleIds)) {
            for (const id of p.saleIds) saleIdSet.add(id)
        }
    }
    const sales = {}
    if (saleIdSet.size) {
        const activeSales = await DL.Sale.read(
            { id: { $in: [...saleIdSet] }, status: DL.Sale.constants.STATUS.ACTIVE },
            DL.Sale.defaultSelect,
            { limit: 0 }
        )
        for (const sale of activeSales) sales[sale.id] = sale
    }
    return sales
}

// Fetch the wide, unfiltered base set for a carousel (cached 1h).
// Stock filtering/annotating happens per-request in applyStockView.
export async function fetchCarouselBase(DL, block, domainId, baseLimit) {
    const resolved = await resolveCarouselFilter(DL, block?.carousel, domainId)
    if (!resolved) return { products: [], sales: {} }
    const { filter, search } = resolved
    const select = carouselSelect(DL)
    let products
    if (search) {
        products = await DL.Product.search(search, filter, { limit: baseLimit, select })
    } else {
        const sort = resolveCarouselSort(DL, block.carousel)
        products = await DL.Product.read(filter, select, { limit: baseLimit, sort })
    }
    const sales = await collectSales(DL, products)
    return { products, sales }
}

// Derive the shopper-specific view from a cached base set.
export function applyStockView(products, mode, storeId, limit) {
    let list = products || []
    if (mode === 'filter' && storeId) {
        list = list.filter(p => Array.isArray(p.storeIds) && p.storeIds.includes(storeId))
    } else if (mode === 'annotate' && storeId) {
        list = list.map(p => ({
            ...p,
            inStock: Array.isArray(p.storeIds) ? p.storeIds.includes(storeId) : true
        }))
    }
    return list.slice(0, limit)
}

export function filterSalesFor(products, sales) {    const ids = new Set()
    for (const p of products || []) {
        if (Array.isArray(p?.saleIds)) {
            for (const id of p.saleIds) ids.add(id)
        }
    }
    return Object.fromEntries(
        Object.entries(sales || {}).filter(([id]) => ids.has(id))
    )
}

export function sha1(data) {
    return crypto.createHash('sha1')
        .update(Buffer.isBuffer(data) ? data : String(data))
        .digest('hex')
}

// storeIds is internal routing data (which stores carry the product) —
// never expose it to shoppers.
export function stripStoreIds(products) {
    return (products || []).map(p => {
        if (!p || !('storeIds' in p)) return p
        const { storeIds, ...rest } = p
        return rest
    })
}
