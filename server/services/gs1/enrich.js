import pLimit from 'p-limit'
import { mergeRabbinates } from '#common/components/Kashrut/constants.js'
import { enqueueProcessJobs } from '#server/queues/gs1Queues.js'
import { bufferProduct, bufferRaw, bufferProgress, flush } from './bulk.js'
import { stageZip, buildFingerprint, hashFingerprint, countStills, rankStills, bucketHasImage, buildImageSizes, isZipBuffer, zipEntryBasenames, baseName, imageExtFromMagic, wrapSingleImage } from './images.js'
import { mem } from './memlog.js'
import { aliasCandidates, aliasEnabled, resolveAlias, aliasMinLen } from './alias.js'
import log from '#server/utils/log.js'
import { isUploadMain } from '#server/services/image/sourcePriority.js'

const enrichBatchSize = () => Number(process.env.GS1_ENRICH_BATCH || 500)
const imageBatchSize = () => Number(process.env.GS1_IMAGE_BATCH || 200)
// p-limit v7 throws on a non-integer/zero concurrency, so clamp to >= 1.
const zipConcurrency = () => Math.max(1, Math.floor(Number(process.env.GS1_ZIP_CONCURRENCY) || 2))
// GS1 files-endpoint image types (per supplier doc): EL = 360° spin set,
// PL = planogram, HE = hero, MK = market images. Observed: HE returns the
// single raw hero bytes (not a zip — wrapped by the fetcher); EL is the
// multi-MB bloat (nested 40-frame container) we never request. Values are
// uppercased to the doc's spelling; genuinely unknown values get HTTP 200 +
// "invalid media type" while known-but-empty ones 404 (both safely skipped).
const mediaTypes = () => String(process.env.GS1_MEDIA_TYPES || 'MK,HE')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)

// Fetch the smallest usable source: try each configured type= filter first,
// stage the first usable response, else fall back to media=all (today's
// behavior, caps intact). A hit is either a zip containing our main still
// or a single raw image (HE returns the hero bytes unarchived — wrapped
// into a one-entry zip, main only; media=all answers that same way when the
// account holds a single still for the product). Per-attempt results are
// logged — that output is the EL/PL/HE/MK mapping proof per product.
// Returns { buffer, via } or null when nothing usable came back.
// rateLimited/transient errors throw (caller retries the batch); anything
// else on a type= attempt just moves to the next candidate.
export async function fetchStagedSource(external, barcode, wantedMain) {
    if (wantedMain) {
        for (const t of mediaTypes()) {
            let buf = null
            try {
                buf = await external.gs1.getMediaZip(barcode, { type: t })
            } catch (e) {
                if (e?.rateLimited || e?.transient) throw e
                log.warn(`[GS1] type=${t} fetch failed for ${barcode}:`, e?.message || e)
                continue
            }
            if (!isZipBuffer(buf)) {
                const wrapped = wrapSingleImage(buf, wantedMain)
                if (wrapped) {
                    log.info(`[GS1] type=${t} for ${barcode}: single image (${buf.length} bytes), wrapped as ${wrapped.name}`)
                    return { buffer: wrapped.buffer, via: `type=${t} (single)` }
                }
                log.info(`[GS1] type=${t} for ${barcode}: not a zip (${buf?.length || 0} bytes), skipping`)
                continue
            }
            const names = zipEntryBasenames(buf)
            if (names?.has(wantedMain)) {
                log.info(`[GS1] type=${t} for ${barcode}: ${buf.length} bytes, main present (${names.size} entries)`)
                return { buffer: buf, via: `type=${t}` }
            }
            log.info(`[GS1] type=${t} for ${barcode}: ${buf.length} bytes but main missing, skipping`)
        }
    }
    const buf = await external.gs1.getMediaZip(barcode)
    if (!buf?.length) return null
    // media=all answers a single still exactly like type=HE: the raw image
    // bytes, not a zip. Measured on prod: 88 of the 299 imageless targets
    // arrive this way, and returning them unwrapped uploaded a JPEG as
    // application/zip; phase 3 then failed unzipping it on every run, so the
    // product stayed imageless forever while we paid for the upload each night.
    const wrapped = wrapSingleImage(buf, wantedMain)
    if (wrapped) {
        log.info(`[GS1] media=all for ${barcode}: single image (${buf.length} bytes), wrapped as ${wrapped.name}`)
        return { buffer: wrapped.buffer, via: 'media=all (single)' }
    }
    return { buffer: buf, via: 'media=all' }
}

// The main entry of a lean product read — one helper so every guard above
// reads the same field the same way.
const mainImageOf = product => (product?.images?.product || []).find(img => img?.main)

/**
 * Products that own a family containing any of `barcodes` (i.e. the barcode is
 * in one of their `scannableBarcodes`). A GTIN for an alias is data about the
 * owning product — the alias must never become a product of its own, so every
 * enrichment/imaged lookup resolves to the owner instead of the raw GTIN.
 */
async function loadAliasOwners(DL, barcodes = []) {
    const wanted = [...new Set((barcodes || []).filter(Boolean))]
    if (!wanted.length || !DL?.Product?.Model?.find) return { byAlias: new Map(), products: [] }

    const owners = await DL.Product.Model.find(
        { scannableBarcodes: { $in: wanted } },
        {
            _id: 0,
            id: 1,
            barcode: 1,
            scannableBarcodes: 1,
            storeIds: 1,
            nameLocked: 1,
            'kashrut.rabbinates': 1,
            'images.product': 1
        }
    ).lean()

    const byAlias = new Map()
    for (const owner of owners || [])
        for (const alias of owner.scannableBarcodes || [])
            if (wanted.includes(alias)) byAlias.set(alias, owner)
    return { byAlias, products: owners || [] }
}

// Phase 2: enrich products from the local gs1_products collection.
// Two-pass to bound memory: page barcode-only docs, gate in bulk, then load
// full raws ONLY for passers. No GS1 calls, no per-doc writes, no images.
// afterBarcode: cursor for paging. force runs filter on nothing (every status
// qualifies), so without a cursor the same first page is returned forever and
// runEnrich loops indefinitely. barcode is unique + filterable, so the range +
// sort is index-backed and each batch advances strictly forward.
export async function enrichBatch({ DL, external, runId, onlyInStock = true, barcode = '', force = false, afterBarcode = '', skipEmptyValues = false }) {
    const filter = {}
    if (barcode) filter.barcode = barcode
    else if (afterBarcode) filter.barcode = { $gt: afterBarcode }
    if (!force) filter.status = 'fetched'
    const page = await DL.Gs1Product.read(
        filter,
        { _id: 0, barcode: 1, aliasShort: 1, aliasStatus: 1 },
        { limit: enrichBatchSize(), sort: { barcode: 1 } }
    )
    if (!page?.length) return { done: true, enriched: 0, skipped: 0, total: 0, next: null }

    const barcodes = [...new Set(page.map(r => r?.barcode).filter(Boolean))]
    // Manual mappings (confirmed in the admin UI) may point at a short that is
    // not a derivable suffix, so load those products explicitly.
    const manualShortByGtin = new Map()
    for (const r of page)
        if (r?.barcode && r?.aliasStatus === 'manual' && r?.aliasShort)
            manualShortByGtin.set(r.barcode, r.aliasShort)
    const lookupBarcodes = [...new Set([...barcodes, ...manualShortByGtin.values()])]
    // kashrut.rabbinates rides along with the existence gate: the GS1 write must
    // merge over what the product already carries (see mergeRabbinates below).
    const products = await DL.Product.read(
        { barcode: { $in: lookupBarcodes } },
        { _id: 0, barcode: 1, storeIds: 1, nameLocked: 1, 'kashrut.rabbinates': 1, 'images.product': 1 },
        { limit: 0 }
    )
    const rabbinatesByBarcode = new Map(
        (products || []).filter(p => p?.barcode).map(p => [p.barcode, p?.kashrut?.rabbinates])
    )
    const productSet = new Set((products || []).map(p => p.barcode))
    const inStockSet = new Set((products || []).filter(p => (p.storeIds || []).length).map(p => p.barcode))
    // Barcodes whose main image is the admin's own upload — GS1 may enrich
    // every other field but must never clear or replace those images.
    const uploadedSet = new Set((products || [])
        .filter(p => p?.barcode && isUploadMain(mainImageOf(p)))
        .map(p => p.barcode))
    // A human-chosen name is never overwritten by supplier data.
    const nameLockedSet = new Set((products || []).filter(p => p?.nameLocked).map(p => p.barcode))

    // GTINs that equal an alias resolve to the owning product. Load those
    // owners once and merge them into the same gate maps as exact products.
    const aliasOwners = await loadAliasOwners(DL, [...barcodes, ...manualShortByGtin.values()])
    const aliasOwnerByBarcode = aliasOwners.byAlias
    for (const owner of aliasOwners.products) {
        if (!owner?.barcode) continue
        if (!rabbinatesByBarcode.has(owner.barcode))
            rabbinatesByBarcode.set(owner.barcode, owner?.kashrut?.rabbinates)
        if ((owner.storeIds || []).length) inStockSet.add(owner.barcode)
        if (isUploadMain(mainImageOf(owner))) uploadedSet.add(owner.barcode)
        if (owner.nameLocked) nameLockedSet.add(owner.barcode)
    }

    let enriched = 0
    let skipped = 0
    // passing entries are { gtin, short, match }: gtin keys the gs1_products raw
    // doc, short keys the Product write, match records how it was resolved.
    const passing = []
    const unmatched = []
    for (const barcode of barcodes) {
        const manualShort = manualShortByGtin.get(barcode)
        if (manualShort) {
            // A manual mapping whose short is now a family alias belongs to the
            // owning product; write there so the alias never gets a doc.
            const short = aliasOwnerByBarcode.get(manualShort)?.barcode || manualShort
            if (!productSet.has(short) && !aliasOwnerByBarcode.has(manualShort)) {
                bufferRaw({ barcode, status: 'skipped', skipReason: 'no-product' })
                skipped++
            } else if (onlyInStock && !inStockSet.has(short)) {
                bufferRaw({ barcode, status: 'skipped', skipReason: 'out-of-stock' })
                skipped++
            } else {
                passing.push({ gtin: barcode, short, match: 'manual' })
            }
            continue
        }
        if (!productSet.has(barcode)) {
            // Not an exact product: maybe it is a family alias. The owner is
            // the product; writing under the GTIN would create a duplicate.
            const owner = aliasOwnerByBarcode.get(barcode)
            if (owner) {
                if (onlyInStock && !inStockSet.has(owner.barcode)) {
                    bufferRaw({ barcode, status: 'skipped', skipReason: 'out-of-stock', aliasStatus: '', aliasCandidates: [] })
                    skipped++
                } else {
                    passing.push({ gtin: barcode, short: owner.barcode, match: 'family' })
                }
                continue
            }
            unmatched.push(barcode)
            continue
        }
        const reason = (onlyInStock && !inStockSet.has(barcode)) ? 'out-of-stock' : null
        if (reason) {
            bufferRaw({ barcode, status: 'skipped', skipReason: reason, aliasStatus: '', aliasCandidates: [] })
            skipped++
        } else {
            passing.push({ gtin: barcode, short: barcode, match: 'exact' })
        }
    }

    // Alias fallback: GTINs with no exact Product match resolve to a short
    // internal code — any proper suffix of the GTIN (see alias.js). Product-only
    // gate, no Comax check. Ambiguous GTINs (2+ distinct shorts) are parked for
    // manual matching, never guessed.
    if (unmatched.length && aliasEnabled()) {
        const minLen = aliasMinLen()
        const candidates = new Set()
        for (const g of unmatched)
            for (const c of aliasCandidates(g, minLen)) candidates.add(c)
        const foundSet = new Set()
        if (candidates.size) {
            const aliasProducts = await DL.Product.read(
                { barcode: { $in: [...candidates] } },
                { _id: 0, barcode: 1, storeIds: 1, nameLocked: 1, 'kashrut.rabbinates': 1, 'images.product': 1 },
                { limit: 0 }
            )
            for (const p of aliasProducts || []) {
                if (!p?.barcode) continue
                foundSet.add(p.barcode)
                if (!rabbinatesByBarcode.has(p.barcode))
                    rabbinatesByBarcode.set(p.barcode, p?.kashrut?.rabbinates)
                if ((p.storeIds || []).length) inStockSet.add(p.barcode)
                if (isUploadMain(mainImageOf(p))) uploadedSet.add(p.barcode)
                if (p.nameLocked) nameLockedSet.add(p.barcode)
            }
            // A suffix candidate can itself be a family alias (the old doc was
            // removed when it was merged). Resolve those to their owner too.
            const familyOwners = await loadAliasOwners(DL, [...candidates])
            for (const owner of familyOwners.products) {
                if (!owner?.barcode) continue
                if (!rabbinatesByBarcode.has(owner.barcode))
                    rabbinatesByBarcode.set(owner.barcode, owner?.kashrut?.rabbinates)
                if ((owner.storeIds || []).length) inStockSet.add(owner.barcode)
                if (isUploadMain(mainImageOf(owner))) uploadedSet.add(owner.barcode)
                if (owner.nameLocked) nameLockedSet.add(owner.barcode)
            }
            for (const [alias, owner] of familyOwners.byAlias)
                aliasOwnerByBarcode.set(alias, owner)
        }
        for (const g of unmatched) {
            const r = resolveAlias(g, foundSet, minLen)
            if (r?.short) {
                const short = aliasOwnerByBarcode.get(r.short)?.barcode || r.short
                if (onlyInStock && !inStockSet.has(short)) {
                    bufferRaw({ barcode: g, status: 'skipped', skipReason: 'out-of-stock', aliasStatus: '', aliasCandidates: [] })
                    skipped++
                } else {
                    passing.push({ gtin: g, short, match: 'alias' })
                    log.info(`[GS1] Alias ${g} → ${short}`)
                }
            } else if (r?.ambiguous) {
                bufferRaw({
                    barcode: g, status: 'skipped', skipReason: 'alias-ambiguous',
                    aliasStatus: 'ambiguous', aliasCandidates: r.ambiguous, aliasUpdatedAt: new Date()
                })
                log.warn(`[GS1] Ambiguous alias ${g} matches: ${r.ambiguous.join(',')} — awaiting manual match`)
                skipped++
            } else {
                bufferRaw({ barcode: g, status: 'skipped', skipReason: 'no-product', aliasStatus: '', aliasCandidates: [] })
                skipped++
            }
        }
    } else {
        for (const g of unmatched) {
            bufferRaw({ barcode: g, status: 'skipped', skipReason: 'no-product', aliasStatus: '', aliasCandidates: [] })
            skipped++
        }
    }

    if (passing.length) {
        const full = await DL.Gs1Product.read(
            { barcode: { $in: passing.map(p => p.gtin) } },
            { _id: 0, barcode: 1, raw: 1 },
            { limit: 0 }
        )
        const fullByBarcode = new Map((full || []).map(r => [r?.barcode, r]))
        for (const { gtin: barcode, short, match } of passing) {
            const stored = fullByBarcode.get(barcode)
            if (!stored?.raw) {
                bufferRaw({ barcode, status: 'skipped', skipReason: 'empty-raw' })
                skipped++
                continue
            }
            let mapped
            try {
                mapped = external.gs1.mapGs1ToProduct(stored.raw)
            } catch (e) {
                bufferRaw({ barcode, status: 'skipped', skipReason: `map-error: ${e?.message || e}` })
                skipped++
                continue
            }
            // Alias writes MUST override doc.barcode: bulkWrite $sets the whole
            // doc, so a GTIN left in mapped.doc would rewrite Product.barcode
            // (or upsert a duplicate product under the GTIN).
            const doc = { ...mapped.doc, barcode: short }
            // The label is the brand GS1 reports for THIS GTIN. When the GTIN is
            // an alias (or resolved through one), its brand is not the product's
            // brand — writing it would put another package's brand on the family.
            // Only the product's own barcode may set the label.
            if (barcode !== short) delete doc.label
            // A locked name was chosen by a human; the supplier may own every
            // other field but never this one.
            if (nameLockedSet.has(short)) delete doc.name
            // Rabbinates are a set, not a value: whatever the product already
            // carries (manual load, earlier run) survives the GS1 $set. Only codes
            // GS1 adds are appended, so repeated nightly runs cannot grow the list.
            if (doc.kashrut)
                doc.kashrut.rabbinates = mergeRabbinates(rabbinatesByBarcode.get(short), doc.kashrut.rabbinates)
            // Report-seeded raws are partial: an absent report field maps to '' in the
            // mapper, and a plain $set would blank whatever the product already has.
            // With skipEmptyValues only fields carrying actual content are written.
            if (skipEmptyValues) {
                for (const key of Object.keys(doc)) {
                    if (key === 'barcode' || doc[key] instanceof Date) continue
                    const v = doc[key]
                    const empty = v == null || v === ''
                        || (Array.isArray(v) && !v.length)
                        || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)
                    if (empty) delete doc[key]
                }
            }
            // Supplier removed/unchecked images → clear local images (status
            // untouched). An admin upload outranks the supplier: keep it.
            if ((mapped.removal.deleted || mapped.removal.unchecked) && !uploadedSet.has(short)) {
                bufferProduct(short, { ...doc, 'images.product': [] })
                log.warn(`[GS1] Images cleared for ${barcode} (supplier removal flag)`)
            } else {
                bufferProduct(short, doc)
            }
            // Record how the pair resolved so the admin review list stays
            // accurate after a manual match or a catalog change. A manual
            // mapping keeps its candidates for audit; auto matches clear them.
            const aliasAudit = match === 'manual'
                ? { aliasStatus: 'manual', aliasShort: short, aliasUpdatedAt: new Date() }
                : { aliasStatus: 'auto', aliasShort: short !== barcode ? short : '', aliasCandidates: [], aliasUpdatedAt: new Date() }
            bufferRaw({ barcode, status: 'enriched', ...aliasAudit })
            enriched++
        }
    }

    bufferProgress(runId, { processed: page.length })
    await flush()
    mem(`enrich-batch done=${enriched + skipped} enriched=${enriched}`)
    const next = [...page].reverse().find(r => r?.barcode)?.barcode || null
    return { done: false, enriched, skipped, total: page.length, next }
}

export async function runEnrich(opts) {
    const totals = { enriched: 0, skipped: 0, batches: 0, rescued: 0 }
    // Rescue pass first: products created (or restocked) after a skip stay
    // 'skipped' forever because enrich only pages status:'fetched'.
    try {
        totals.rescued = await requeueRescued(opts)
    } catch (e) {
        log.warn('[GS1] Rescue pass failed (continuing enrich):', e?.message || e)
    }
    let after = ''
    for (; ;) {
        const res = await enrichBatch({ ...opts, afterBarcode: after })
        totals.enriched += res.enriched
        totals.skipped += res.skipped
        totals.batches++
        if (res.done) break
        // Single-barcode mode: one batch is the whole job.
        if (opts?.barcode) break
        // A batch with no usable barcode can't advance the cursor — stop rather
        // than re-read the same page forever.
        if (!res.next || res.next === after) break
        after = res.next
    }
    await flush()
    log.success(`[GS1] Enrich done: ${totals.enriched} enriched, ${totals.skipped} skipped, ${totals.batches} batches, ${totals.rescued} rescued`)
    return totals
}

// Pre-pass for runEnrich: flip previously-skipped docs whose gate now passes
// back to 'fetched' (skipReason is cleared by the bulk flusher) so the normal
// flow picks them up. Covers catalog churn (product created after the skip)
// and restocks (out-of-stock skip, now in stock — or a false-run following a
// true-run). map-error/empty-raw are NOT rescuable by enrich alone.
//
// 'no-gs1-record' (our GS1 account does not carry the barcode) is deliberately
// NOT here: re-asking about every one of those barcodes on every enrich run
// would be a full-catalog GS1 sweep. Later additions arrive on their own, as
// New_Publish / Update_Product messages that gs1/sync queues.
const RESCUABLE_REASONS = ['no-product', 'out-of-stock', 'alias-ambiguous']
export async function requeueRescued({ DL, onlyInStock = true, barcode = '' }) {
    const match = barcode
        ? { status: 'skipped', skipReason: { $in: RESCUABLE_REASONS }, barcode }
        : { status: 'skipped', skipReason: { $in: RESCUABLE_REASONS } }
    const candidates = await DL.Gs1Product.read(
        match,
        { _id: 0, barcode: 1, skipReason: 1, aliasShort: 1, aliasStatus: 1 },
        { limit: 0 }
    )
    const barcodes = [...new Set((candidates || []).map(r => r?.barcode).filter(Boolean))]
    if (!barcodes.length) return 0
    const infoByBarcode = new Map((candidates || []).filter(r => r?.barcode).map(r => [r.barcode, r]))

    // Manual mappings survive catalog churn: include their shorts in the gate.
    const manualShortByGtin = new Map()
    for (const r of candidates || [])
        if (r?.barcode && r?.aliasStatus === 'manual' && r?.aliasShort)
            manualShortByGtin.set(r.barcode, r.aliasShort)
    const lookupBarcodes = [...new Set([...barcodes, ...manualShortByGtin.values()])]

    const products = await DL.Product.read(
        { barcode: { $in: lookupBarcodes } },
        { _id: 0, barcode: 1, storeIds: 1 },
        { limit: 0 }
    )
    const productSet = new Set((products || []).map(p => p.barcode))
    const inStockSet = new Set((products || []).filter(p => (p.storeIds || []).length).map(p => p.barcode))

    // GTINs that are family aliases resolve to the owner product.
    const aliasOwners = await loadAliasOwners(DL, lookupBarcodes)
    const aliasOwnerByBarcode = aliasOwners.byAlias
    for (const owner of aliasOwners.products) {
        if (!owner?.barcode) continue
        productSet.add(owner.barcode)
        if ((owner.storeIds || []).length) inStockSet.add(owner.barcode)
    }

    // Alias fallback for GTINs with no exact Product match: product-only gate,
    // same rule as enrichBatch. Ambiguous GTINs are flagged for manual matching.
    const aliasShortByGtin = new Map()
    const ambiguousByGtin = new Map()
    const unmatched = barcodes.filter(b =>
        !productSet.has(b) && !manualShortByGtin.has(b) && !aliasOwnerByBarcode.has(b))
    if (unmatched.length && aliasEnabled()) {
        const minLen = aliasMinLen()
        const candidates = new Set()
        for (const g of unmatched)
            for (const c of aliasCandidates(g, minLen)) candidates.add(c)
        if (candidates.size) {
            const aliasProducts = await DL.Product.read(
                { barcode: { $in: [...candidates] } },
                { _id: 0, barcode: 1, storeIds: 1 },
                { limit: 0 }
            )
            const foundSet = new Set()
            for (const p of aliasProducts || []) {
                if (!p?.barcode) continue
                foundSet.add(p.barcode)
                if ((p.storeIds || []).length) inStockSet.add(p.barcode)
            }
            // A suffix candidate can be a family alias whose doc was removed.
            const familyOwners = await loadAliasOwners(DL, [...candidates])
            for (const owner of familyOwners.products) {
                if (!owner?.barcode) continue
                if ((owner.storeIds || []).length) inStockSet.add(owner.barcode)
            }
            for (const [alias, owner] of familyOwners.byAlias)
                aliasOwnerByBarcode.set(alias, owner)
            for (const g of unmatched) {
                const r = resolveAlias(g, foundSet, minLen)
                if (r?.short) {
                    const short = aliasOwnerByBarcode.get(r.short)?.barcode || r.short
                    aliasShortByGtin.set(g, short)
                }
                else if (r?.ambiguous) ambiguousByGtin.set(g, r.ambiguous)
            }
        }
    }

    let rescued = 0
    let touched = false
    for (const b of barcodes) {
        const info = infoByBarcode.get(b) || {}
        const manualShort = manualShortByGtin.get(b)
        const manualOwner = manualShort
            ? (aliasOwnerByBarcode.get(manualShort)?.barcode || manualShort)
            : ''
        const short = manualShort
            ? (productSet.has(manualOwner) ? manualOwner : '')
            : (aliasOwnerByBarcode.get(b)?.barcode || aliasShortByGtin.get(b) || (productSet.has(b) ? b : ''))
        if (short) {
            if (onlyInStock && !inStockSet.has(short)) {
                // Already parked with the right reason and no stale alias state.
                if (info.skipReason === 'out-of-stock' && !manualShort && !info.aliasStatus) continue
                touched = true
                bufferRaw({
                    barcode: b, status: 'skipped', skipReason: 'out-of-stock',
                    ...(manualShort ? {} : { aliasStatus: '', aliasCandidates: [] })
                })
                continue
            }
            touched = true
            bufferRaw({
                barcode: b, status: 'fetched',
                ...(manualShort
                    ? { aliasStatus: 'manual', aliasShort: manualShort }
                    : { aliasStatus: '', aliasCandidates: [] })
            })
            rescued++
            continue
        }
        if (ambiguousByGtin.has(b)) {
            if (info.skipReason === 'alias-ambiguous' && info.aliasStatus === 'ambiguous') continue
            touched = true
            bufferRaw({
                barcode: b, status: 'skipped', skipReason: 'alias-ambiguous',
                aliasStatus: 'ambiguous', aliasCandidates: ambiguousByGtin.get(b), aliasUpdatedAt: new Date()
            })
            continue
        }
        // A manual mapping whose product vanished must survive catalog churn:
        // keep the admin's decision and only refresh the skip reason.
        if (manualShort) {
            if (info.skipReason === 'no-product' && info.aliasStatus === 'manual') continue
            touched = true
            bufferRaw({ barcode: b, status: 'skipped', skipReason: 'no-product', aliasStatus: 'manual', aliasShort: manualShort })
            continue
        }
        // Neither exact, unique alias, nor manual: make the reason explicit and
        // clear any stale ambiguity flag.
        if (info.skipReason === 'no-product' && !info.aliasStatus) continue
        touched = true
        bufferRaw({ barcode: b, status: 'skipped', skipReason: 'no-product', aliasStatus: '', aliasCandidates: [] })
    }
    if (touched) {
        await flush()
        if (rescued) log.info(`[GS1] Rescued ${rescued} previously-skipped docs back to fetched`)
    }
    return rescued
}

// Phase 3 launcher: download zips (bounded concurrency), stage to GCS,
// enqueue CPU process jobs. Reads enriched raws; skips imageless/removed.
// force: reprocess even when imagesDone or the main fingerprint matches
// (needed to backfill alternates onto pre-alternates mains).
// limit: max raw docs to take this call (0 = all) — keeps single HTTP calls
// inside Cloud Run request timeouts; repeat until queued=0.
const DAY_MS = 24 * 60 * 60 * 1000

// How long a failed attempt parks its doc. Long enough that the batch loop
// walks the whole catalog instead of re-reading the same failures every run,
// short enough that media GS1 publishes later gets picked up on its own (a
// force run ignores the window).
const imagesRetryDays = () => {
    const value = Number(process.env.GS1_IMAGES_RETRY_DAYS)
    return Number.isFinite(value) && value > 0 ? value : 14
}

/**
 * Which gs1_products docs the images phase takes. Exported for tests: this
 * filter is the whole parking mechanism, and getting it wrong silently stops
 * the phase (prod sat at 8,313 never-imaged docs behind exactly that).
 *
 * force   — ignore imagesDone and the park window (manual backfill)
 * barcode — single-product probe: ignores the park window, so the answer is
 *           about GS1, not about when we last asked.
 */
export function imagesEligibility({ barcode = '', force = false, retryDays = imagesRetryDays(), now = Date.now() } = {}) {
    const base = barcode ? { status: 'enriched', barcode } : { status: 'enriched' }
    if (force) return { ...base, assetCount: { $gt: 0 } }
    const filter = { ...base, assetCount: { $gt: 0 }, imagesDone: { $ne: true } }
    if (!barcode) {
        filter.$or = [
            { imagesRetriedAt: { $exists: false } },
            { imagesRetriedAt: { $lte: new Date(now - retryDays * DAY_MS) } }
        ]
        // 'no-account' means GS1 does not expose this product's media to us at
        // all: permanent for the barcode, so it is never retried automatically.
        filter.imagesRetryReason = { $ne: 'no-account' }
    }
    return filter
}

// Why a doc was parked. GS1's 400 ("pcode is cannot be null") is a per-account
// visibility answer, not a failure — retrying it is pure waste.
export const parkReason = e => (e?.notFound ? 'no-account' : 'no-zip')

const formatParkReasons = reasons => Object.entries(reasons)
    .map(([reason, n]) => `${reason} ${n}`).join(', ') || 'none'

export async function runImages({ DL, external, runId, force = false, limit = 0, barcode = '' }) {
    const cap = Number(limit || process.env.GS1_IMAGE_LIMIT || 0)
    const limitZip = pLimit(zipConcurrency())
    const totals = { queued: 0, skipped: 0, reused: 0, parked: 0, parkReasons: {} }
    const parkedSamples = []
    let taken = 0
    // Barcodes already handled this call. The loop pages the collection, but
    // a still-eligible doc (force runs ignore imagesDone; a queued doc's
    // worker hasn't marked it yet) would otherwise be staged + re-queued on
    // EVERY batch — the taken=1..N infinite loop. Each barcode is handled
    // once per call; cross-call repeats still work via imageLimit batching.
    const seen = new Set()
    for (; ;) {
        if (cap && taken >= cap) break
        const raws = await DL.Gs1Product.read(
            imagesEligibility({ barcode, force }),
            { _id: 0, barcode: 1, raw: 1, aliasShort: 1, aliasStatus: 1 },
            { limit: imageBatchSize() }
        )
        if (!raws?.length) break
        const fresh = raws.filter(r => r?.barcode && !seen.has(r.barcode))
        // Nothing here is new to this call: every doc in the page was handled
        // above or is parked, so the eligible set is drained.
        if (!fresh.length) break
        for (const r of fresh) seen.add(r.barcode)

        const barcodes = fresh.map(r => r.barcode)
        // Manual mappings may point at a short that is not a derivable suffix.
        const manualShortByGtin = new Map()
        for (const r of fresh)
            if (r?.aliasStatus === 'manual' && r?.aliasShort) manualShortByGtin.set(r.barcode, r.aliasShort)
        const lookupBarcodes = [...new Set([...barcodes, ...manualShortByGtin.values()])]
        const products = await DL.Product.read(
            { barcode: { $in: lookupBarcodes } },
            { _id: 0, id: 1, barcode: 1, images: 1 },
            { limit: 0 }
        )
        const productByBarcode = new Map((products || []).map(p => [p.barcode, p]))
        for (const [gtin, short] of manualShortByGtin) {
            const product = productByBarcode.get(short)
            if (product) productByBarcode.set(gtin, product)
        }
        // A GTIN that is a family alias is keyed by the GTIN in the raw, but the
        // images belong to the owning product. Explicit aliases resolve even
        // with suffix guessing disabled.
        const missingAlias = barcodes.filter(b => !productByBarcode.has(b) && !manualShortByGtin.has(b))
        if (missingAlias.length) {
            const familyOwners = await loadAliasOwners(DL, missingAlias)
            const ownerByBarcode = new Map((familyOwners.products || []).map(p => [p.barcode, p]))
            for (const [alias, owner] of familyOwners.byAlias) {
                const product = ownerByBarcode.get(owner.barcode)
                if (product) productByBarcode.set(alias, product)
            }
        }
        // Alias fallback: enriched-via-alias raws are keyed by GTIN, so the
        // exact lookup above misses — resolve to the short-code product. A
        // manual mapping whose product vanished must not fall back to guessing.
        if (aliasEnabled()) {
            const missing = barcodes.filter(b => !productByBarcode.has(b) && !manualShortByGtin.has(b))
            if (missing.length) {
                const minLen = aliasMinLen()
                const candidates = new Set()
                for (const g of missing)
                    for (const c of aliasCandidates(g, minLen)) candidates.add(c)
                if (candidates.size) {
                    const aliasProducts = await DL.Product.read(
                        { barcode: { $in: [...candidates] } },
                        { _id: 0, id: 1, barcode: 1, images: 1 },
                        { limit: 0 }
                    )
                    const foundSet = new Set((aliasProducts || []).map(p => p.barcode))
                    const shortByBarcode = new Map((aliasProducts || []).map(p => [p.barcode, p]))
                    // A suffix candidate may be a family alias instead of a doc.
                    const familyOwners = await loadAliasOwners(DL, [...candidates])
                    const ownerByBarcode = new Map((familyOwners.products || []).map(p => [p.barcode, p]))
                    for (const [alias, owner] of familyOwners.byAlias) {
                        const product = ownerByBarcode.get(owner.barcode)
                        if (product) shortByBarcode.set(alias, product)
                    }
                    for (const g of missing) {
                        const r = resolveAlias(g, foundSet, minLen)
                        if (r?.short) {
                            productByBarcode.set(g, shortByBarcode.get(r.short))
                            log.info(`[GS1] Alias ${g} → ${r.short} (images)`)
                        }
                    }
                }
            }
        }

        await Promise.all(raws.map(stored => limitZip(async () => {
            const barcode = stored.barcode
            // A failed attempt leaves a dated park so the phase advances: the
            // doc drops out of imagesEligibility() until the window passes,
            // instead of being re-fetched at the head of every batch.
            const park = reason => {
                bufferRaw({ barcode, imagesRetriedAt: new Date(), imagesRetryReason: reason })
                totals.parked++
                totals.parkReasons[reason] = (totals.parkReasons[reason] || 0) + 1
                if (parkedSamples.length < 20) parkedSamples.push(`${barcode}(${reason})`)
            }
            const product = productByBarcode.get(barcode)
            if (!product) {
                bufferRaw({ barcode, status: 'skipped', skipReason: 'no-product-images' })
                totals.skipped++
                return
            }
            // An admin upload outranks supplier media: retire the raw without
            // touching images, so phase 3 never renders over it.
            if (isUploadMain(mainImageOf(product))) {
                bufferRaw({ barcode, imagesDone: true })
                totals.skipped++
                return
            }
            let mapped
            try {
                mapped = external.gs1.mapGs1ToProduct(stored.raw)
            } catch {
                bufferRaw({ barcode, status: 'skipped', skipReason: 'map-error-images' })
                totals.skipped++
                return
            }
            if (mapped.removal.deleted || mapped.removal.unchecked) {
                bufferRaw({ barcode, imagesDone: true })
                totals.skipped++
                return
            }
            const fingerprint = hashFingerprint(
                buildFingerprint(barcode, mapped.mediaAssets, mapped.modificationTime))
            const main = (product.images?.product || []).find(i => i?.main)
            const mainMatches = main?.sourceUrl?.startsWith('gs1://') && main?.hash === fingerprint
            // Single-still products gain nothing from reprocessing: with a matching
            // main there are no alternates to backfill (also bounds force runs).
            if (mainMatches && (countStills(mapped.mediaAssets) < 2 || !force)) {
                bufferRaw({ barcode, imagesDone: true })
                return
            }
            // Bucket-first: expected keys already in GCS are reused — no GS1
            // download, no render. Keys/assetIds come from ranked metadata.
            const { main: rankedMain, alternates: rankedAlts } = rankStills(mapped.mediaAssets)
            const ranked = [
                ...(rankedMain ? [{ ...rankedMain, isMain: true }] : []),
                ...rankedAlts.map(r => ({ ...r, isMain: false }))
            ]
            const reuse = {}
            let allPresent = ranked.length > 0
            for (const r of ranked) {
                if (await bucketHasImage(product.id, r.key)) {
                    reuse[r.key] = { assetId: r.asset?.id || null, sizes: buildImageSizes(product.id, r.key) }
                } else {
                    allPresent = false
                }
            }
            if (allPresent) {
                const images = ranked.map(r => ({
                    main: r.isMain,
                    sourceUrl: r.isMain ? `gs1://${barcode}` : `gs1://${barcode}/${r.asset?.id || r.asset?.filename}`,
                    hash: fingerprint,
                    sizes: reuse[r.key].sizes
                }))
                const update = { 'images.product': images, gs1SyncedAt: new Date() }
                if ((product.images?.product || []).length === 0 && product.status === 'hidden')
                    update.status = 'active'
                // Key by the product's own barcode: alias-enriched raws are
                // GTIN-keyed, and writing under the GTIN would upsert a
                // duplicate product. sourceUrls above stay gs1://GTIN.
                bufferProduct(product.barcode, update)
                bufferRaw({ barcode, fingerprint, imagesDone: true })
                totals.reused++
                return
            }
            let zip = null
            let via = ''
            try {
                const res = await fetchStagedSource(external, barcode, baseName(ranked[0]?.asset?.filename || ''))
                zip = res?.buffer || null
                via = res?.via || ''
            } catch (e) {
                if (e?.rateLimited || e?.transient) throw e
                // Over-cap zips would otherwise re-download every run and stay
                // imageless (no imagesDone, no skip marker). Park them as
                // skipped — a force run reprocesses if the supplier shrinks it.
                if (/too large/.test(e?.message || '')) {
                    const bytes = (/(\d+) bytes/.exec(e.message || '') || [])[1] || '?'
                    bufferRaw({ barcode, imagesDone: true, skipReason: `zip-too-large:${bytes}` })
                    log.warn(`[GS1] Zip too large, parked ${barcode} (${bytes} bytes)`)
                    totals.skipped++
                    return
                }
                log.warn(`[GS1] Zip failed for ${barcode}:`, e?.message || e)
                return park(parkReason(e))
            }
            if (!zip) return park('no-zip')
            // Only a zip may be staged: the pipeline unzips it in phase 3, so
            // anything else (a JSON error body, HTML, an image we could not
            // wrap) would be uploaded, queued, and fail there — after paying for
            // the upload, leaving a stagingPath to an object phase 3 deleted.
            if (!isZipBuffer(zip)) {
                log.warn(`[GS1] Not a zip for ${barcode} (${zip.length} bytes, via=${via}) — not staging`)
                return park('unwrappable')
            }
            mem(`zip-downloaded gtin=${barcode} via=${via} bytes=${zip.length}`)
            const stagingPath = await stageZip(barcode, zip)
            bufferRaw({ barcode, fingerprint, stagingPath })
            await enqueueProcessJobs([{
                productId: product.id,
                gtin: barcode,
                stagingPath,
                fingerprint,
                productCode: mapped.productCode,
                runId,
                mediaAssets: mapped.mediaAssets,
                reuse
            }])
            totals.queued++
        })))

        bufferProgress(runId, { processed: raws.length })
        await flush()
        taken += raws.length
        mem(`images-batch taken=${taken} queued=${totals.queued} reused=${totals.reused} parked=${totals.parked}`)
    }
    await flush()
    log.success(`[GS1] Images launch done: ${totals.queued} queued, ${totals.reused} reused, `
        + `${totals.parked} parked (${formatParkReasons(totals.parkReasons)}), ${totals.skipped} skipped`)
    // Bounded sample: the full list is in gs1_products (imagesRetryReason /
    // imagesRetriedAt), and the log is the only place a run says what went wrong.
    if (parkedSamples.length)
        log.info(`[GS1] Parked: ${parkedSamples.join(', ')}${totals.parked > parkedSamples.length ? ', …' : ''}`)
    return totals
}

export default { enrichBatch, runEnrich, runImages, requeueRescued }
