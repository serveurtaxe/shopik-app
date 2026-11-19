import { getProductImageUrls } from '#common/functions/productImageUrl.js'
import { getSalePriceInfo, isSingleUnitSale } from '#common/functions/salePrice.js'
import { isWeightProduct, parseWeightOrVolume } from '#common/functions/unitPrice.js'

// Pure XML rendering for the sitemap and the Google Merchant feed. Nothing here
// touches the DB or Redis, so every rule can be unit-tested directly.
//
// Sitemap protocol: https://www.sitemaps.org/protocol.html
// Merchant feed:   https://support.google.com/merchants/answer/7052112

export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'
export const SITEMAP_NS = 'http://www.sitemaps.org/schemas/sitemap/0.9'
export const GOOGLE_FEED_NS = 'http://base.google.com/ns/1.0'
export const CURRENCY = 'ILS'

const INVALID_XML_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g

export function escapeXml(value) {
    return String(value ?? '')
        .replace(INVALID_XML_CHARS, '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
}

// Merchant Center wants plain text: tags and entities must not reach the feed.
export function cleanText(value) {
    if (value == null) return ''
    return String(value)
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;?/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
}

// Code-point aware so a long Hebrew name never gets cut mid-surrogate.
export function truncate(value, max) {
    const chars = Array.from(String(value ?? ''))
    return chars.length > max ? chars.slice(0, max).join('') : chars.join('')
}

// Path segments are encoded one by one: encodeURIComponent on the whole path
// would also encode the separators and produce /products/a%2Fb.
export function encodePath(path) {
    return String(path || '')
        .split('/')
        .filter(Boolean)
        .map(encodeURIComponent)
        .join('/')
}

export function renderSitemapUrl({ loc, lastmod }) {
    const mod = lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ''
    return `<url><loc>${escapeXml(loc)}</loc>${mod}</url>`
}

export function renderUrlset(urls = []) {
    const rows = urls.map(url => typeof url === 'string' ? url : renderSitemapUrl(url))
    return `${XML_DECLARATION}\n<urlset xmlns="${SITEMAP_NS}">\n${rows.join('\n')}\n</urlset>\n`
}

export function emptyUrlset() {
    return renderUrlset([])
}

export function renderSitemapIndex(entries = []) {
    const rows = entries.map(entry => {
        const lastmod = entry.lastmod ? `<lastmod>${escapeXml(entry.lastmod)}</lastmod>` : ''
        return `<sitemap><loc>${escapeXml(entry.loc)}</loc>${lastmod}</sitemap>`
    })
    return `${XML_DECLARATION}\n<sitemapindex xmlns="${SITEMAP_NS}">\n${rows.join('\n')}\n</sitemapindex>\n`
}

export function renderGoogleFeed({ title, link, description, items = [] }) {
    return `${XML_DECLARATION}
<rss version="2.0" xmlns:g="${GOOGLE_FEED_NS}">
<channel>
<title>${escapeXml(title)}</title>
<link>${escapeXml(link)}</link>
<description>${escapeXml(description)}</description>
${items.join('\n')}
</channel>
</rss>
`
}

export function normalizeGtin(value) {
    const digits = String(value ?? '').trim()
    return /^(\d{8}|\d{12,14})$/.test(digits) ? digits : ''
}

export function formatAmount(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return ''
    return String(Math.round(n * 1000) / 1000)
}

export function formatMoney(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n.toFixed(2) : ''
}

// Google compares the package size against a base measure and requires
// measure > base (both must fall in 1..1000). Base is 1 g/ml for packages up to
// 100 and 100 g/ml above that; packages of 1000+ switch to kg/l so the measure
// value stays inside Google's range while the base keeps the same unit family.
export function unitPricing(product) {
    if (!product || isWeightProduct(product)) return null
    const parsed = parseWeightOrVolume(product)
    if (!parsed || !(parsed.amount > 1) || parsed.amount > 50000) return null
    const family = parsed.type === 'liquid' ? 'liquid' : 'weight'
    const small = family === 'liquid' ? 'ml' : 'g'
    const large = family === 'liquid' ? 'l' : 'kg'
    const amount = parsed.amount
    let measure
    if (amount >= 1000) {
        const value = formatAmount(amount / 1000)
        if (!value) return null
        measure = `${value} ${large}`
    } else {
        const value = formatAmount(amount)
        if (!value) return null
        measure = `${value} ${small}`
    }
    return {
        measure,
        baseMeasure: amount > 100 ? `100 ${small}` : `1 ${small}`
    }
}

function isoDate(value) {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function g(name, value) {
    if (value == null || value === '') return ''
    return `<g:${name}>${escapeXml(value)}</g:${name}>`
}

function priceText(value) {
    const amount = formatMoney(value)
    return amount ? `${amount} ${CURRENCY}` : ''
}

// One <item>. Returns null when Google would reject the item anyway: no id,
// no title, no positive price, or no main image.
export function renderGoogleFeedItem({ product, price, sale, origin, now = new Date() }) {
    const id = String(product?.id || '').trim()
    const title = truncate(cleanText(product?.name), 150)
    const regularPrice = Number(price)
    if (!id || !title || !(regularPrice > 0)) return null

    const images = Array.isArray(product?.images?.product) ? product.images.product : []
    const mainIndex = images.findIndex(image => image?.main)
    if (mainIndex < 0) return null
    const imageUrls = getProductImageUrls(id, images, 'xl')
    const imageLink = imageUrls[mainIndex]
    if (!imageLink) return null

    const description = truncate(cleanText(product?.description) || title, 5000)
    const link = `${origin}/product/${encodeURIComponent(id)}`
    const gtin = normalizeGtin(product?.barcode)
    const brand = truncate(cleanText(product?.producer), 70)
    const productType = truncate(cleanText(product?.category?.title), 750)
    const googleCategory = truncate(cleanText(product?.googleCategory), 750)
    const unit = unitPricing(product)

    const parts = [
        g('id', id),
        g('title', title),
        g('description', description),
        g('link', link),
        g('image_link', imageLink),
        ...imageUrls
            .filter((_, index) => index !== mainIndex)
            .slice(0, 10)
            .map(url => g('additional_image_link', url)),
        g('availability', 'in_stock'),
        g('condition', 'new'),
        g('price', priceText(regularPrice))
    ]

    // Only a price or percent sale actually lowers the unit price. `receive-*`
    // sales describe an extra item, and a bundle (`amount > 1`) prices the pack,
    // not one unit — neither has a Merchant `sale_price` representation.
    const saleKind = sale?.kind
    if (sale && isSingleUnitSale(sale) && (saleKind === 'price' || saleKind === 'percent')) {
        const start = isoDate(sale.start)
        const end = isoDate(sale.end)
        const started = !start || new Date(start) <= now
        if (end && started && new Date(end) > now) {
            const info = getSalePriceInfo({ price: regularPrice }, sale)
            if (info && info.saleSingle > 0 && info.saleSingle < regularPrice) {
                parts.push(g('sale_price', priceText(info.saleSingle)))
                if (start) parts.push(g('sale_price_effective_date', `${start}/${end}`))
            }
        }
    }

    if (gtin) parts.push(g('gtin', gtin))
    if (brand) parts.push(g('brand', brand))
    // A GTIN without a brand is an incomplete identifier pair; telling Google
    // "no identifiers" is honest and avoids a warning for a half-filled pair.
    parts.push(g('identifier_exists', gtin && brand ? 'yes' : 'no'))
    if (googleCategory) parts.push(g('google_product_category', googleCategory))
    if (productType) parts.push(g('product_type', productType))
    if (unit) {
        parts.push(g('unit_pricing_measure', unit.measure))
        parts.push(g('unit_pricing_base_measure', unit.baseMeasure))
    }

    return `<item>${parts.filter(Boolean).join('')}</item>`
}
