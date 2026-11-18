/**
 * Read-only index audit: what the schemas declare vs what the database actually
 * has, plus the data that blocks a unique build.
 *
 * Atlas recommends an index for a barcode lookup that scanned every comax_products
 * row, yet `barcode` is declared unique — and a unique index build that fails
 * (duplicate or empty barcodes) is reported and dropped, leaving the collection
 * unindexed on its own key. This prints the facts a recommendation cannot carry:
 * which declared indexes are really present, which are leftovers from an earlier
 * shape, and what a collection pays in index bytes for them.
 *
 * Read-only by construction: the schemas are compiled into mongoose Schemas to read
 * their declarations, never into Models, so nothing is created, dropped or rebuilt.
 */
import mongoose from 'mongoose'
import productSchema, { meta as productMeta } from '#server/dl/schemas/product.js'
import comaxProductSchema, { meta as comaxProductMeta } from '#server/dl/schemas/comax_product.js'
import saleSchema, { meta as saleMeta } from '#server/dl/schemas/sale.js'
import comaxSaleSchema, { meta as comaxSaleMeta } from '#server/dl/schemas/comax_sale.js'

// The collections this audit exists for. A new collection is a new line.
const AUDIT = [
    { name: 'products', schema: productSchema, meta: productMeta },
    { name: 'comax_products', schema: comaxProductSchema, meta: comaxProductMeta, barcodes: true },
    { name: 'sales', schema: saleSchema, meta: saleMeta },
    { name: 'comax_sales', schema: comaxSaleSchema, meta: comaxSaleMeta }
]

// Index keys in declaration order, directions dropped: {a:1,b:1} and {a:-1,b:-1}
// are the same index to MongoDB, which walks either direction.
const keyOrder = keys => Object.keys(keys || {}).join(',')

const spec = keys => Object.entries(keys || {}).map(([k, v]) => `${k}:${v}`).join(', ')

const indexSize = (stats, name) => {
    const bytes = stats.indexSizes?.[name]
    return bytes ? ` ${Math.round(bytes / 1024)} KB` : ''
}

// Declarations as createModels.js would apply them: the auto id/active fields and
// meta.index, spread the same way addIndexesFromMeta spreads it. Field-level
// `unique` / `index` come out of the Schema itself.
function declaredIndexes({ schema, meta }) {
    const compiled = new mongoose.Schema(
        { ...schema, id: { type: String, unique: true }, active: { type: Boolean, default: true } },
        { versionKey: false, timestamps: meta?.timestamps ?? true }
    )
    for (const idx of meta?.index || []) {
        if (Array.isArray(idx)) compiled.index(...idx)
        else compiled.index(idx)
    }

    return compiled.indexes().map(entry => {
        const keys = Array.isArray(entry) ? entry[0] : entry
        const options = Array.isArray(entry) && entry[1] ? entry[1] : {}
        return {
            order: keyOrder(keys),
            text: spec(keys),
            unique: !!options.unique,
            sparse: !!options.sparse
        }
    }).filter(entry => entry.order)
}

function describe(entry, actual, stats) {
    const declared = declaredIndexes(entry)
    const have = actual
        .filter(idx => idx.name !== '_id_')
        .map(idx => ({
            order: keyOrder(idx.key),
            unique: !!idx.unique,
            line: `${idx.name} {${spec(idx.key)}}`
                + `${idx.unique ? ' unique' : ''}${idx.sparse ? ' sparse' : ''}`
                + indexSize(stats, idx.name)
        }))

    for (const idx of have) console.log(`  have    ${idx.line}`)

    for (const want of declared) {
        if (have.some(idx => idx.order === want.order)) continue
        // An index that starts with these keys, in this order, answers the same
        // query and carries the sort: the declaration is extended, not missing.
        const covering = have.find(idx => idx.order.startsWith(`${want.order},`))
        console.log(covering
            ? `  EXTENDED ${want.text} → ${covering.line}`
            : `  MISSING  ${want.text}${want.unique ? ' unique' : ''}${want.sparse ? ' sparse' : ''}`)
    }

    for (const idx of have) {
        if (declared.some(d => d.order === idx.order)) continue
        // Shorter than what the schema now declares: the index a previous shape
        // needed and the extended one replaced.
        const replacedBy = declared.find(d => d.order.startsWith(`${idx.order},`))
        console.log(`  EXTRA   ${idx.line}`
            + (replacedBy ? ` — replaced by {${replacedBy.text}}` : ' — not declared by the schema'))
    }

    return have
}

// The unique index on barcode only builds when every row has a distinct one.
// Without that index nothing enforces it, so the duplicate scan is the finding.
async function reportBarcodes(collection, uniqueIndexed) {
    if (!uniqueIndexed) {
        const dups = await collection.aggregate([
            { $group: { _id: '$barcode', n: { $sum: 1 } } },
            { $match: { n: { $gt: 1 } } },
            { $sort: { n: -1 } },
            { $limit: 10 }
        ], { allowDiskUse: true }).toArray()

        if (dups.length)
            return console.log(`  barcode: no index, and duplicates block building one: ${dups.map(d => `${d._id}×${d.n}`).join(', ')}`)
        return console.log('  barcode: no index, no duplicates — a unique index would build')
    }

    const missing = await collection.countDocuments({ barcode: { $in: [null, ''] } })
    console.log(`  barcode: unique index present (${missing} rows without a barcode)`)
}

export default async function auditDbIndexes({ db } = {}) {
    if (!db) {
        console.log('[auditIndexes] db required — pass mongoose.connection.db')
        return
    }

    for (const entry of AUDIT) {
        const collection = db.collection(entry.name)
        let actual, stats, count
        try {
            [actual, stats, count] = await Promise.all([
                collection.listIndexes().toArray(),
                // Collection.stats() is gone in driver 6; collStats carries the same
                // numbers, and on a shared Atlas tier it answers zero for them — so
                // the doc count comes from estimatedDocumentCount and sizes only
                // print when they are actually reported.
                db.admin().command({ collStats: entry.name }).catch(() => ({})),
                collection.estimatedDocumentCount()
            ])
        } catch (e) {
            console.log(`\n[${entry.name}] unreadable: ${e?.codeName || e?.errmsg || e}`)
            continue
        }

        const bytes = stats.storageStats?.size ?? stats.size
        console.log(`\n[${entry.name}] ${count} docs`
            + (bytes ? `, ${Math.round(bytes / 1024 / 1024)} MB` : '')
            + (stats.totalIndexSize ? `, indexes ${Math.round(stats.totalIndexSize / 1024)} KB` : ''))

        const have = describe(entry, actual, stats)
        if (entry.barcodes)
            await reportBarcodes(collection, have.some(idx => idx.order === 'barcode' && idx.unique))
    }
}
