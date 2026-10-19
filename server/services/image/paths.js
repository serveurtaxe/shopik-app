import path from 'path'

export function buildObjectPath(productId, size, key = '') {
    // Main image keeps the legacy flat path (client builds it directly);
    // alternates live under a keyed subfolder.
    return key
        ? path.posix.join('images', 'products', productId, key, `${size}.webp`)
        : path.posix.join('images', 'products', productId, `${size}.webp`)
}

// variant keeps the desktop and mobile art-direction images in separate
// folders — they share a slideKey, so a shared path would overwrite one with
// the other.
export function buildDisplayObjectPath(blockId, slideKey, size, variant = 'desktop') {
    return path.posix.join('images', 'display-blocks', blockId, slideKey, variant, `${size}.webp`)
}

export function buildUrl(productId, size, key = '') {
    const base = (process.env.FILES_BASE_URL || '').replace(/\/+$/, '')
    return `${base}/${buildObjectPath(productId, size, key)}`
}