import sharp from 'sharp'
import { promises as fs } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import download from '../download.js'
import log from '#server/utils/log.js'

// 500px on either side (either width>=500 or height>=500 passes).
export const MIN_SIDE = 500
const FOLDER_MIN_SIDE = MIN_SIDE
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

// Priority order: Rami Levy first, others are fallback.
export const PROVIDER_ORDER = ['rami-levy', 'yochananof', 'super-pharm', 'selfpoint', 'osem']

// Local disk cache: verified image bytes keyed by barcode, so follow-up
// runs never re-scrape. <barcode>.jpg = bytes, <barcode>.json = provenance.
// Override with SCRAPE_CACHE_DIR; kept out of git (see .gitignore).
const CACHE_DIR = process.env.SCRAPE_CACHE_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'data', 'scrape-cache')

async function cacheRead(barcode) {
    try {
        const [buffer, metaRaw] = await Promise.all([
            fs.readFile(path.join(CACHE_DIR, `${barcode}.jpg`)),
            fs.readFile(path.join(CACHE_DIR, `${barcode}.json`), 'utf8')
        ])
        const meta = JSON.parse(metaRaw)
        if (!buffer?.length || !meta?.sourceUrl) return null
        return { ...meta, buffer }
    } catch {
        return null
    }
}

async function cacheWrite(barcode, { buffer, site, sourceUrl, pageUrl, width, height }) {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true })
        await Promise.all([
            fs.writeFile(path.join(CACHE_DIR, `${barcode}.jpg`), buffer),
            fs.writeFile(
                path.join(CACHE_DIR, `${barcode}.json`),
                JSON.stringify({ site, sourceUrl, pageUrl, width, height })
            )
        ])
    } catch (e) {
        log.warn(`[Scrape] cache write failed for ${barcode}:`, e?.message || e)
    }
}

// Folder seeding (--folder bulk mode): ingest pre-delivered files named
// <barcode>.jpg/.jpeg/.webp/.png as if a provider had found them. Uses the
// folder min-size gate (500px, see FOLDER_MIN_SIDE); verified bytes are
// written to the disk cache so scrapeProduct processes them through the
// normal pipeline (resize → upload → images.product). sourceUrl is a
// local:// ref — only used for hashing/provenance, the stored ref is
// scrape://local/<barcode>. Files failing the gate are reported back (the
// caller prints the report).
export async function seedFromFolder(dir) {
    const names = await fs.readdir(dir).catch(() => null)
    if (!names) throw new Error(`cannot read folder: ${dir}`)
    const matched = new Map() // barcode → { file, width, height }
    const rejected = [] // { file, barcode, reason, width, height, error }
    let ignored = 0 // non-barcode files (xlsx, stray files etc.)
    for (const name of names.sort()) {
        const m = /^(\d{8,14})\.(jpe?g|webp|png)$/i.exec(name)
        if (!m) {
            ignored++
            continue
        }
        const barcode = m[1]
        if (matched.has(barcode)) {
            rejected.push({ file: name, barcode, reason: 'duplicate-barcode' })
            continue
        }
        const file = path.join(dir, name)
        let width = 0
        let height = 0
        try {
            const buffer = await fs.readFile(file)
            const meta = await sharp(buffer).metadata()
            width = meta.width || 0
            height = meta.height || 0
            if (width < FOLDER_MIN_SIDE && height < FOLDER_MIN_SIDE) {
                rejected.push({ file: name, barcode, reason: 'too-small', width, height })
                continue
            }
            await cacheWrite(barcode, {
                buffer,
                site: 'local',
                sourceUrl: `local://${file.split(path.sep).join('/')}`,
                pageUrl: '',
                width,
                height
            })
            matched.set(barcode, { file: name, width, height })
        } catch (e) {
            rejected.push({ file: name, barcode, reason: 'unreadable', width, height, error: e?.message || String(e) })
        }
    }
    return { matched, rejected, ignored }
}

async function fetchText(url, { timeoutMs = 25000, referer = 'https://www.google.com/' } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'he-IL,he;q=0.9', Referer: referer }
        })
        if (!res.ok) return { status: res.status, text: '' }
        return { status: res.status, finalUrl: res.url, text: await res.text() }
    } finally {
        clearTimeout(timer)
    }
}

async function fetchJson(url, { timeoutMs = 25000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, {
            signal: controller.signal,
            headers: { 'User-Agent': UA, Accept: 'application/json' }
        })
        if (!res.ok) return null
        return await res.json().catch(() => null)
    } catch {
        return null
    } finally {
        clearTimeout(timer)
    }
}

// Rami Levy: barcode-keyed CDN, open JSON search API for traceability.
// https://img.rami-levy.co.il/product/<barcode>/large.jpg (observed 1024x1024)
function ramiLevy(barcode) {
    return [{
        site: 'rami-levy',
        sourceUrl: `https://img.rami-levy.co.il/product/${barcode}/large.jpg`,
        pageUrl: `https://www.rami-levy.co.il/api/search?q=${encodeURIComponent(barcode)}`
    }]
}

// Yochananof (Magento/Adobe Commerce, open GraphQL): products are keyed
// by barcode SKU. Images are manufacturer packshots (observed 1686x2306).
// No auth, no Store header (default store returns empty — omit it).
async function yochananof(barcode) {
    const query = `query($f: ProductAttributeFilterInput){ products(filter: $f, pageSize: 3){ items{ sku image{ url } small_image{ url } } } }`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 25000)
    try {
        const res = await fetch('https://api.yochananof.co.il/graphql', {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
            body: JSON.stringify({ query, variables: { f: { sku: { eq: barcode } } } })
        })
        if (!res.ok) return []
        const json = await res.json().catch(() => null)
        const items = json?.data?.products?.items || []
        const out = []
        for (const it of items) {
            if (it?.sku !== barcode) continue
            for (const key of ['image', 'small_image']) {
                const url = it?.[key]?.url
                if (url && /^https?:\/\//.test(url) && !out.some(c => c.sourceUrl === url))
                    out.push({
                        site: 'yochananof',
                        sourceUrl: url,
                        pageUrl: `https://yochananof.co.il/search?q=${encodeURIComponent(barcode)}`
                    })
            }
        }
        return out
    } catch {
        return []
    } finally {
        clearTimeout(timer)
    }
}

// Super-Pharm: barcode-keyed Azure blob storage. The tile rung
// (desktop/small, ~166x270) is too small — desktop/large (~580x940) passes.
function superPharm(barcode) {
    return [{
        site: 'super-pharm',
        sourceUrl: `https://superpharmstorage.blob.core.windows.net/hybris/products/desktop/large/${barcode}.jpg`,
        pageUrl: `https://shop.super-pharm.co.il/search?q=${encodeURIComponent(barcode)}`
    }]
}

// Self-Point platform (allcomplete r-1573/bid-3447, mehadrin r-1520/bid-2771,
// tivtaam r-1062/bid-924): public retailer API, branch-scoped name search.
// Barcode-as-query is NOT indexed — search by product name, then match the
// barcode from gs1-URL paths or the product detail endpoint. Image CDN caps
// at large=600px, so this sits after the full-size providers.
const SELFPOINT_STORES = [
    { rid: 1573, bid: 3447 },
    { rid: 1520, bid: 2771 },
    { rid: 1062, bid: 924 }
]

function selfpointImageUrl(tpl) {
    if (!tpl || !/^https?:\/\//.test(tpl)) return ''
    return tpl.replace('{{size}}', 'large').replace("{{extension||'jpg'}}", 'jpg')
}

function barcodeFromGs1Url(url) {
    const m = /gs1-products\/\d+\/(?:large|medium|small)\/(\d{8,14})-\d+\/\1\//.exec(url || '')
    return m?.[1] || ''
}

async function selfpoint(barcode, name) {
    const candidates = []
    if (!name) return candidates
    for (const { rid, bid } of SELFPOINT_STORES) {
        const base = `https://api.self-point.com/v2/retailers/${rid}/branches/${bid}`
        const search = await fetchJson(
            `${base}/products?languageId=1&from=0&size=5&query=${encodeURIComponent(name)}`
        )
        const items = search?.products || []
        // Free matches first (gs1-URL embeds the barcode), details last.
        const withGs1 = []
        const others = []
        for (const item of items.slice(0, 5)) {
            const tpl = item?.image?.url || ''
            if (barcodeFromGs1Url(tpl) === barcode) {
                candidates.push({
                    site: 'selfpoint',
                    sourceUrl: selfpointImageUrl(tpl),
                    pageUrl: `https://api.self-point.com/v2/retailers/${rid}/branches/${bid}/products/${item?.id}?languageId=1`
                })
            } else if (item?.id) {
                others.push(item)
            }
        }
        for (const item of others.slice(0, 3)) {
            const detail = await fetchJson(`${base}/products/${item.id}?languageId=1`)
            const match = detail?.barcode === barcode || detail?.localBarcode === barcode
            if (!match) continue
            const url = selfpointImageUrl(detail?.image?.url)
            if (url) candidates.push({ site: 'selfpoint', sourceUrl: url, pageUrl: `${base}/products/${item.id}?languageId=1` })
        }
        if (candidates.length) break
    }
    return candidates
}

// Osem-Nestle (manufacturer): no barcode-keyed URL — the packshot filename
// embeds the barcode (e.g. 6919901_<barcode>_1_Enlarge.jpg) but the numeric
// prefix is product-specific. Discovery: Drupal site search by product name
// (server-rendered brand links), then keep the first product page whose
// og:image URL or HTML mentions the barcode.
async function osem(barcode, name) {
    const candidates = []
    if (!name) return candidates
    const { text } = await fetchText(
        `https://www.osem-nestle.co.il/search/search?keys=${encodeURIComponent(name)}`,
        { referer: 'https://www.osem-nestle.co.il/' }
    ).catch(() => ({ text: '' }))
    if (!text) return candidates
    const links = [...new Set(
        [...text.matchAll(/href="(\/brands\/[^"]+)"/g)]
            .map(m => { try { return decodeURIComponent(m[1]) } catch { return m[1] } })
            .filter(p => p.split('/').filter(Boolean).length >= 3)
            .map(p => `https://www.osem-nestle.co.il${encodeURI(p)}`)
    )].slice(0, 3)
    for (const pageUrl of links) {
        const page = await fetchText(pageUrl, { referer: 'https://www.osem-nestle.co.il/' }).catch(() => null)
        if (!page?.text) continue
        const og = /<meta[^>]+property=["']og:image["'][^>]*content=["']([^"']+)["']/i.exec(page.text)?.[1]
        if (!og) continue
        const sourceUrl = new URL(og, pageUrl).href
        if (sourceUrl.includes(barcode) || page.text.includes(barcode))
            candidates.push({ site: 'osem', sourceUrl, pageUrl })
    }
    return candidates
}

const builders = { 'rami-levy': ramiLevy, yochananof, 'super-pharm': superPharm, selfpoint, osem }

// Download + sharp-verify. Reuses the pipeline downloader (20MB cap).
// Disk cache is checked first: once found for a barcode we never search
// again. Verified bytes are written to disk and handed along so the caller
// doesn't download a second time.
// A "totally white" packshot: no pixel darker than ~240 in any channel.
// Some sources (notably Self-Point) serve blank placeholders; they must not
// win over a real photo, and a cached blank must not short-circuit a retry.
// Note: grayscale blanks yield a single channel, so check every channel
// rather than assuming RGB.
async function isBlank(buffer) {
    try {
        const { channels } = await sharp(buffer).stats()
        return channels.length > 0 && channels.every(c => c.min >= 240)
    } catch {
        return false
    }
}

// One retry on 429/503 (CDN throttle) after a short backoff — a throttle
// is "unknown", not a miss.
// Returns the first candidate with width>=MIN_SIDE or height>=MIN_SIDE.
export async function findCandidate(barcode, { name = '', order = PROVIDER_ORDER } = {}) {
    const tried = []
    const cached = await cacheRead(barcode)
    if (cached?.buffer?.length && !(await isBlank(cached.buffer))) {
        log.info(`[Scrape] ${barcode} ← disk cache (${cached.site} ${cached.width}x${cached.height})`)
        return { candidate: { ...cached, fromDisk: true }, tried }
    }
    for (const site of order) {
        const built = await builders[site](barcode, name)
        for (const cand of built) {
            let meta = null
            let error = ''
            let buffer = null
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    buffer = await download(cand.sourceUrl)
                    meta = await sharp(buffer).metadata()
                    break
                } catch (e) {
                    error = e?.message || String(e)
                    buffer = null
                    if (/HTTP 429|HTTP 503/.test(error) && attempt === 0) {
                        await new Promise(r => setTimeout(r, 8000))
                        continue
                    }
                    break
                }
            }
            const pass = ((meta?.width || 0) >= MIN_SIDE || (meta?.height || 0) >= MIN_SIDE) &&
                !(buffer && await isBlank(buffer))
            tried.push({ ...cand, width: meta?.width || 0, height: meta?.height || 0, pass, error })
            if (pass) {
                log.success(`[Scrape] ${barcode} ← ${cand.site} ${meta.width}x${meta.height} ${cand.sourceUrl}`)
                // Hand the verified bytes along so the caller doesn't
                // download a second time (halves CDN load; a re-download
                // could 429 after verification already passed).
                const candidate = { ...cand, width: meta.width, height: meta.height, buffer }
                await cacheWrite(barcode, candidate)
                return { candidate, tried }
            }
            log.info(`[Scrape] ${barcode} ✗ ${cand.site} ${meta ? `${meta.width}x${meta.height}${buffer && await isBlank(buffer) ? ' blank' : ''}` : error}`)
        }
    }
    return { candidate: null, tried }
}
