import { runEnrich } from '#server/services/gs1/enrich.js'
import { initBulkFlusher } from '#server/services/gs1/bulk.js'
import { scanDel } from '#server/utils/redisSafe.js'

// POST /api/gs1/alias {barcode, short, apply?, clear?}
// Confirm the short product a GTIN belongs to. A manual mapping wins over
// suffix guessing even when it is not a derivable suffix. `apply` runs the
// single-barcode enrich immediately, so Comax + GS1 data land on the product
// as soon as the admin saves. `clear` drops the mapping and lets the matcher
// resolve the GTIN again.
export default async function gs1Alias(payload, { DL, external }) {
    const barcode = String(payload?.barcode || '').trim()
    if (!barcode) throw { status: 400, message: 'barcode is required' }

    const doc = await DL.Gs1Product.readOne({ barcode }, { _id: 0, barcode: 1, aliasStatus: 1 })
    if (!doc) throw { status: 400, message: 'gs1 product does not exist' }

    const clear = payload?.clear === true
    const short = String(payload?.short || '').trim()
    if (!clear && !short) throw { status: 400, message: 'short is required' }

    if (!clear) {
        const product = await DL.Product.readOne({ barcode: short }, { _id: 0, barcode: 1, name: 1 })
        if (!product) throw { status: 400, message: 'product does not exist' }
    }

    const set = clear
        ? { aliasStatus: '', aliasShort: '', aliasCandidates: [], aliasUpdatedAt: new Date(), status: 'fetched' }
        : { aliasStatus: 'manual', aliasShort: short, aliasUpdatedAt: new Date(), status: 'fetched' }
    await DL.Gs1Product.updateOne(
        { barcode },
        { $set: set, $unset: { skipReason: '' } }
    )

    // gs1/aliases answers its badge count from a short-TTL Redis key —
    // the modal re-lists right after a confirm and must see the new total.
    await scanDel(DL.redis, 'gs1:aliasCount:*')

    if (!payload?.apply) return { ok: true, barcode, short: clear ? '' : short }

    // Reuse the normal single-barcode pipeline: it writes the merged product
    // (Comax fields stay, GS1 fields are added) and records the resolution.
    initBulkFlusher(DL)
    const result = await runEnrich({
        DL,
        external,
        runId: `alias:${Date.now()}`,
        onlyInStock: false,
        barcode
    })
    return { ok: true, barcode, short: clear ? '' : short, applied: true, result }
}

gs1Alias.config = {
    required: ['barcode'],
    permissions: ['comax_product:update'],
    auth: 'required'
}
