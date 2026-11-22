import { redisGet, redisSet } from '#server/utils/redisSafe.js'

const STATUSES = new Set(['ambiguous', 'manual'])

// GS1 name lives in the raw supplier payload, not on the light doc.
// The page selects only the two leaves gs1Name reads, not the whole
// Main_Fields blob (~4× lighter transfer on populated statuses).
function gs1Name(doc) {
    const main = doc?.raw?.product_info?.Main_Fields || {}
    return [main.BrandName, main.Short_Description].filter(Boolean).join(' ').trim()
}

// Small, UI-friendly shape for a candidate product. `missing` is a real state:
// a short can disappear from the catalog between matching and review.
function productSummary(product) {
    if (!product) return null
    const stores = (product.storeIds || []).length
    return {
        barcode: product.barcode,
        name: product.name || '',
        status: product.status || '',
        stores,
        inStock: stores > 0,
        image: (product.images?.product || []).find(image => image?.main)?.sizes?.s || ''
    }
}

// POST /api/gs1/aliases {status?, search?, limit?, skip?}
// Lists GTINs parked for manual matching (ambiguous) or already confirmed
// (manual), with the short products they could map to. The Comax products page
// uses this for its GS1 matching modal.
export default async function gs1Aliases(payload, { DL }) {
    const status = STATUSES.has(payload?.status) ? payload.status : 'ambiguous'
    const limit = Math.min(Math.max(1, Number(payload?.limit) || 50), 200)
    const skip = Math.max(0, Number(payload?.skip) || 0)
    const search = String(payload?.search || '').trim()

    const filter = { aliasStatus: status }
    // barcode stays prefix-searchable (partial GTIN typing): GTINs are digits,
    // so a case-insensitive prefix regex still bounds to the unique barcode
    // index range. aliasStatus could not get the same treatment — see schema.
    if (search) filter.barcode = search

    // The badge count scans the status prefix of a 12k collection; alias
    // states change in nightly batches and in gs1/alias (which drops these
    // keys), so a short TTL answers it from Redis.
    const countKey = `gs1:aliasCount:${status}`
    let total = Number(await redisGet(DL.redis, countKey))
    if (!Number.isFinite(total)) {
        total = await DL.Gs1Product.count(filter)
        redisSet(DL.redis, countKey, String(total), 'EX', 600)
    }

    const docs = await DL.Gs1Product.read(
        filter,
        {
            _id: 0,
            barcode: 1,
            aliasStatus: 1,
            aliasShort: 1,
            aliasCandidates: 1,
            aliasUpdatedAt: 1,
            'raw.product_info.Main_Fields.BrandName': 1,
            'raw.product_info.Main_Fields.Short_Description': 1
        },
        { limit, skip, sort: { barcode: 1 } }
    )

    // Load every candidate in one query instead of one per row.
    const shorts = new Set()
    for (const doc of docs || []) {
        for (const short of doc.aliasCandidates || []) shorts.add(short)
        if (doc.aliasShort) shorts.add(doc.aliasShort)
    }
    const products = shorts.size
        ? await DL.Product.read(
            { $or: [{ barcode: { $in: [...shorts] } }, { scannableBarcodes: { $in: [...shorts] } }] },
            { _id: 0, barcode: 1, scannableBarcodes: 1, name: 1, storeIds: 1, status: 1, 'images.product': 1 },
            { limit: 0 }
        )
        : []
    const byBarcode = new Map()
    for (const product of products || []) {
        if (product?.barcode) byBarcode.set(product.barcode, product)
        // A candidate that is a scan alias resolves to the product that owns it.
        for (const alias of product?.scannableBarcodes || [])
            byBarcode.set(String(alias), product)
    }

    const rows = (docs || []).map(doc => {
        const ordered = doc.aliasStatus === 'manual'
            ? [doc.aliasShort].filter(Boolean)
            : (doc.aliasCandidates || [])
        return {
            barcode: doc.barcode,
            name: gs1Name(doc),
            aliasStatus: doc.aliasStatus,
            aliasShort: doc.aliasShort || '',
            aliasUpdatedAt: doc.aliasUpdatedAt || null,
            candidates: ordered.map(short => productSummary(byBarcode.get(short)) || { barcode: short, missing: true })
        }
    })

    return { rows, total, skip, limit }
}

gs1Aliases.config = {
    required: [],
    permissions: ['comax_product:read'],
    auth: 'required'
}
