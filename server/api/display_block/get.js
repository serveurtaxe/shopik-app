// Public page resolver: ordered banner/carousel blocks for one page context.
// Cache: display:{domainId}:{path}:{mode}, 1h TTL.
//   off      → cached value is final (already sliced to preview limit)
//   annotate → cached wide base (with storeIds), inStock flags added per request
//   filter   → cached wide base, store-filtered + sliced per request
import { withDomainPrice } from '#server/utils/data/withDomainPrice.js'

export default async function get(payload, { DL, _user, req, utils, platform }) {
    // Strict types: body values are client-controlled; objects slip past the
    // `required` check and either throw (path.startsWith) or silently drop
    // filter keys in processFilter (fail-open cross-domain read).
    if (typeof payload.path !== 'string' || !payload.path)
        throw { status: 400, message: 'path required' }
    if (typeof payload.domainId !== 'string' || !payload.domainId)
        throw { status: 400, message: 'domainId required' }
    const path = payload.path
    const domainId = payload.domainId
    // Leading slash is canonical: '/sales' matches admin-stored paths and
    // keeps cache keys + category prefix logic consistent.
    const pagePath = path.startsWith('/') ? path : `/${path}`

    const display = utils.data.displayBlocks
    const { mode, storeId } = await utils.data.withStock.resolveStockContext(req, { DL, utils }, _user)
    const previewLimit = await display.getPreviewLimit(DL, domainId)

    // Storefront gets a resolved flat `price` only; admin keeps `prices`.
    const priceFor = (products) =>
        String(platform || '').includes('admin') ? products : withDomainPrice(products, domainId)
    const key = display.displayCacheKey(domainId, pagePath, mode)
    try {
        const cached = await DL.redis?.get(key)
        if (cached) return deriveView(JSON.parse(cached), mode, storeId, previewLimit, display, priceFor)
    } catch {}

    const now = new Date()
    const blocks = await DL.DisplayBlock.read(
        { domainId, active: true },
        DL.DisplayBlock.defaultSelect,
        { limit: 0, sort: { order: 1 } }
    )

    // Current category for category placement matching (same path decoding as product/get).
    let currentCategory
    if (pagePath.startsWith('/products/')) {
        const categoryPath = pagePath
            .split('/')
            .filter(p => p && p !== 'products')
            .map(p => decodeURIComponent(p))
            .join('/')
        if (categoryPath) {
            currentCategory = await DL.Category.readOne(
                { path: categoryPath },
                { _id: 0, id: 1, parentIds: 1 }
            ).catch(() => null)
        }
    }

    const matched = blocks.filter(block => {
        const { start, end } = block.schedule || {}
        if (start && new Date(start) > now) return false
        if (end && new Date(end) < now) return false
        const placement = block.placement || {}
        if (placement.type === DL.DisplayBlock.constants.PLACEMENT.PATH)
            return placement.path === pagePath || placement.path === pagePath.replace(/^\//, '')
        if (placement.type === DL.DisplayBlock.constants.PLACEMENT.CATEGORY) {
            if (!currentCategory) return false
            if (placement.categoryId === currentCategory.id) return true
            return !!placement.includeSubcategories
                && (currentCategory.parentIds || []).includes(placement.categoryId)
        }
        return false
    })

    const baseLimit = await display.getBaseLimit(DL, domainId)
    const withProducts = []
    for (const block of matched) {
        if (block.kind !== DL.DisplayBlock.constants.KIND.PRODUCT_CAROUSEL) {
            withProducts.push(block)
            continue
        }
        const { products, sales } = await display.fetchCarouselBase(DL, block, domainId, baseLimit)
        if (mode === 'off') {
            const limit = Math.min(block.carousel?.limit || previewLimit, previewLimit)
            const sliced = priceFor(display.stripStoreIds(products.slice(0, limit)))
            withProducts.push({
                ...block,
                products: sliced,
                sales: display.filterSalesFor(sliced, sales)
            })
        } else {
            withProducts.push({ ...block, products, sales })
        }
    }

    const response = { blocks: withProducts }
    try {
        await DL.redis?.set(key, JSON.stringify(response), 'EX', display.DISPLAY_CACHE_TTL_SEC)
    } catch {}

    return deriveView(response, mode, storeId, previewLimit, display, priceFor)
}

function deriveView(response, mode, storeId, previewLimit, display, priceFor = (p) => p) {
    // The cached base always carries storeIds (needed to derive per-store
    // views); responses never do. Re-deriving is idempotent, so off-mode
    // entries (already sliced) pass through unchanged. Flat pricing is
    // resolved at serve time (idempotent — already-priced products pass
    // through), never baked into the cross-request cache shape.
    return {
        blocks: (response.blocks || []).map(block => {
            if (block.kind !== 'product_carousel' || !Array.isArray(block.products)) return block
            const limit = Math.min(block.carousel?.limit || previewLimit, previewLimit)
            const products = priceFor(display.stripStoreIds(
                display.applyStockView(block.products, mode, storeId, limit)
            ))
            return { ...block, products, sales: display.filterSalesFor(products, block.sales) }
        })
    }
}

get.config = {
    auth: 'lax',
    required: ['path', 'domainId']
}
