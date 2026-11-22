import path from 'path'
import sharp from 'sharp'
import storage from '#server/external/storage.js'
import resize from '#server/services/image/resize.js'
import uid from '#common/functions/uid.js'
import { APP_ICON_VARIANTS } from '#common/functions/pwaIconUrl.js'

const MAX_BYTES = 8 * 1024 * 1024
const CACHE_CONTROL = 'public, max-age=31536000, immutable'

// Raster images go through sharp variants; vector/icon + pdf upload raw.
const RASTER_TYPES = ['image/png', 'image/jpeg', 'image/webp']
const IMAGE_TYPES = [...RASTER_TYPES, 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']
const FILE_TYPES = ['application/pdf']

// Bounding-box widths per variant (same convention as IMAGE_SIZES).
const SETTING_IMAGE_SIZES = { l: 600, m: 300, s: 120 }

const DEFAULT_APP_ICON_BG = '#195855'

function sanitizeName(name = 'file') {
    return String(name).split(/[?#]/)[0].split('/').pop().replace(/[^\w.\-]+/g, '-').slice(0, 80) || 'file'
}

function hexToRgb(hex) {
    const value = String(hex || '').trim().replace(/^#/, '')
    const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return null
    return {
        r: parseInt(full.slice(0, 2), 16),
        g: parseInt(full.slice(2, 4), 16),
        b: parseInt(full.slice(4, 6), 16),
        alpha: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1
    }
}

async function resolveAppIconBackground(DL, domainId) {
    try {
        const headerBg = await DL.Setting.readOne({ domainId, key: 'header-bg' })
        const value = headerBg?.value
        const color = typeof value === 'string' ? value : value?.light
        const rgb = hexToRgb(color)
        if (rgb) return rgb
    } catch { }
    return hexToRgb(DEFAULT_APP_ICON_BG)
}

async function renderAppIcon(buffer, { size, padding = 0, background = null }) {
    const inner = Math.max(1, Math.round(size * (1 - padding * 2)))
    const resized = await sharp(buffer)
        .resize({
            width: inner,
            height: inner,
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 }
        })
        .png()
        .toBuffer()

    return sharp({
        create: {
            width: size,
            height: size,
            channels: 4,
            background: background || { r: 0, g: 0, b: 0, alpha: 0 }
        }
    })
        .composite([{ input: resized, gravity: 'center' }])
        .png()
        .toBuffer()
}

// Upload a file for a file/image setting and point the setting value at the
// new relative path. Every upload gets a unique uid dir so the immutable
// cache-control never serves a stale logo after re-upload.
export default async function upload_file(payload, { DL, external }) {
    const { id, fileBase64, filename, contentType } = payload || {}
    if (!id) throw { status: 400, message: 'id required' }
    if (!fileBase64) throw { status: 400, message: 'fileBase64 required' }

    const setting = await DL.Setting.readById(id)
    if (!setting) throw { status: 400, message: 'setting does not exist' }
    const kind = setting.formType
    if (kind !== 'file' && kind !== 'image')
        throw { status: 400, message: 'setting is not a file/image setting' }

    let buffer
    try {
        buffer = Buffer.from(String(fileBase64).split(',').pop(), 'base64')
    } catch {
        throw { status: 400, message: 'invalid file' }
    }
    if (!buffer?.length || buffer.length > MAX_BYTES)
        throw { status: 400, message: 'file too large' }

    const type = String(contentType || '').toLowerCase().split(';')[0].trim()
    const ext = path.extname(String(filename || '').toLowerCase())

    const store = external?.storage || storage
    const version = uid()
    const baseDir = path.posix.join('images', 'settings', String(setting.domainId), String(setting.key), version)
    let basePath
    // Pixel size of the variant the setting URL resolves to, so SSR can emit
    // og:image:width/height without fetching the file.
    let imageSize = null

    if (kind === 'image') {
        const isRaster = RASTER_TYPES.includes(type) || (!type && ['.png', '.jpg', '.jpeg', '.webp'].includes(ext))
        const isRawImage = ['image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon'].includes(type)
            || (!type && ['.svg', '.ico'].includes(ext))

        if (setting.key === 'appIcon') {
            // PWA icons must be raster: browsers/OS launchers do not accept
            // SVG/ICO for installed icons, and iOS needs a PNG apple-touch-icon.
            if (!isRaster)
                throw { status: 400, message: 'app icon must be a raster image (png/jpg/webp)' }
            const background = await resolveAppIconBackground(DL, setting.domainId)
            let variants
            try {
                // Fixed OS-standard PNG variants (see pwaIconUrl.js).
                variants = await Promise.all(
                    APP_ICON_VARIANTS.map(async ({ file, size, padding = 0 }) => [
                        file,
                        await renderAppIcon(buffer, { size, padding, background })
                    ])
                )
            } catch {
                throw { status: 400, message: 'invalid image' }
            }
            await Promise.all(
                variants.map(([name, data]) =>
                    store.uploadFile({
                        path: path.posix.join(baseDir, name),
                        data,
                        contentType: 'image/png',
                        cacheControl: CACHE_CONTROL
                    })
                )
            )
            basePath = baseDir
        } else {
            if (!isRaster && !isRawImage)
                throw { status: 400, message: 'invalid image type (png/jpg/webp/svg/ico only)' }
            if (isRaster) {
                let sizes
                try {
                    sizes = await resize(buffer, setting.sizes || SETTING_IMAGE_SIZES)
                } catch {
                    throw { status: 400, message: 'invalid image' }
                }
                const variants = Object.entries(sizes)
                await Promise.all(
                    variants.map(([name, data]) =>
                        store.uploadFile({
                            path: path.posix.join(baseDir, `${name}.webp`),
                            data,
                            contentType: 'image/webp',
                            cacheControl: CACHE_CONTROL
                        })
                    )
                )
                // Single-variant settings (e.g. seo.ogImage's convert-only
                // `full`) store the exact file, so consumers resolve it without
                // guessing the variant name. Multi-variant settings store the
                // base dir and callers pick a size.
                basePath = variants.length === 1
                    ? path.posix.join(baseDir, `${variants[0][0]}.webp`)
                    : baseDir
                // getSettingFileSize picks the first declared variant (l for
                // the standard l/m/s, full for ogImage); record its real size.
                try {
                    const meta = await sharp(variants[0][1]).metadata()
                    if (meta.width && meta.height)
                        imageSize = { width: meta.width, height: meta.height }
                } catch { }
            } else {
                const rawType = type || (ext === '.svg' ? 'image/svg+xml' : 'image/x-icon')
                const name = `${sanitizeName(path.basename(String(filename || 'image'), path.extname(String(filename || ''))) || 'image')}${ext || (rawType === 'image/svg+xml' ? '.svg' : '.ico')}`
                basePath = path.posix.join(baseDir, name)
                await store.uploadFile({ path: basePath, data: buffer, contentType: rawType, cacheControl: CACHE_CONTROL })
            }
        }
    } else {
        if (type !== 'application/pdf' && ext !== '.pdf')
            throw { status: 400, message: 'invalid file type (pdf only)' }
        const name = `${sanitizeName(path.basename(String(filename || 'file.pdf'), '.pdf') || 'file')}.pdf`
        basePath = path.posix.join(baseDir, name)
        await store.uploadFile({ path: basePath, data: buffer, contentType: 'application/pdf', cacheControl: CACHE_CONTROL })
    }

    // Best-effort cleanup of the previous version so the bucket doesn't bloat.
    const prev = setting.value
    if (typeof prev === 'string' && prev.startsWith('images/settings/') && prev !== basePath) {
        try {
            const bucket = store.getBucket()
            const prefix = /\.(webp|png|jpe?g|svg|ico|pdf)$/i.test(prev)
                ? prev.slice(0, prev.lastIndexOf('/') + 1)
                : `${prev.replace(/\/+$/, '')}/`
            const [files] = await bucket.getFiles({ prefix })
            await Promise.all(files.map((f) => f.delete().catch(() => null)))
        } catch { }
    }

    const updated = await DL.Setting.updateOne({ id }, {
        value: basePath,
        width: imageSize?.width ?? null,
        height: imageSize?.height ?? null
    })
    // A null here means the setting is only in the settings cache (not in the
    // database) — report it instead of returning a value that was never stored.
    if (!updated)
        throw { status: 404, message: 'setting could not be updated — the row is not in the database (the settings cache is stale, reset it)' }
    return { basePath, setting: updated }
}

upload_file.config = {
    required: ['id', 'fileBase64'],
    permissions: ['setting:update']
}
