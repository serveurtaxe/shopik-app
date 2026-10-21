// Public show-all data source for /carousel/:id.
// Replays the carousel's stored filter with live pagination (always uncached —
// deep pages are rare and skip-paginated on indexed queries).
import { withDomainPrice } from '#server/utils/data/withDomainPrice.js'

export default async function carousel(payload, { DL, _user, req, utils, platform }) {
    if (typeof payload.id !== 'string' || !payload.id)
        throw { status: 400, message: 'id required' }
    if (typeof payload.domainId !== 'string' || !payload.domainId)
        throw { status: 400, message: 'domainId required' }
    const id = payload.id
    const domainId = payload.domainId
    const skip = Math.max(Number(payload.skip) || 0, 0)
    const limit = payload.limit

    const display = utils.data.displayBlocks
    const block = await DL.DisplayBlock.readOne(
        { id, domainId, active: true },
        DL.DisplayBlock.defaultSelect
    )
    if (!block || block.kind !== DL.DisplayBlock.constants.KIND.PRODUCT_CAROUSEL)
        throw { status: 404, message: 'carousel not found' }

    const { start, end } = block.schedule || {}
    const now = new Date()
    if ((start && new Date(start) > now) || (end && new Date(end) < now))
        throw { status: 404, message: 'carousel not found' }

    const resolved = await display.resolveCarouselFilter(DL, block.carousel, domainId)
    if (!resolved) {
        return { block: carouselMeta(block), products: [], sales: {} }
    }
    const { filter, search } = resolved
    const { mode, storeId } = await utils.data.withStock.resolveStockContext(req, { DL, utils }, _user)
    const effectiveFilter = (mode === 'filter' && storeId)
        ? utils.data.withStock.applyStockFilter(filter, storeId, mode)
        : filter
    const select = display.carouselSelect(DL)
    const pageLimit = Math.min(Math.max(Number(limit) || 30, 1), 100)

    let products
    if (search) {
        products = await DL.Product.search(search, effectiveFilter, {
            skip,
            limit: pageLimit,
            select
        })
    } else {
        products = await DL.Product.read(effectiveFilter, select, {
            skip,
            limit: pageLimit,
            sort: display.resolveCarouselSort(DL, block.carousel)
        })
    }
    if (mode === 'annotate' && storeId) {
        products = utils.data.withStock.annotateInStock(products, storeId, mode)
    }
    products = display.stripStoreIds(products)
    const sales = await display.collectSales(DL, products)
    // Storefront gets a resolved flat `price` only; admin keeps `prices`.
    if (!String(platform || '').includes('admin')) {
        products = withDomainPrice(products, domainId)
    }
    return { block: carouselMeta(block), products, sales }
}

function carouselMeta(block) {
    return {
        id: block.id,
        title: block.title || block.name,
        autoplaySec: block.carousel?.autoplaySec || 0,
        showAllText: block.carousel?.showAllText || ''
    }
}

carousel.config = {
    auth: 'lax',
    required: ['id', 'domainId']
}
