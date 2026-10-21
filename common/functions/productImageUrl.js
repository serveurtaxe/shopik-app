import { runtimeEnv } from './runtimeEnv.js'

export function getProductImageUrl(id, size = 's', key = '') {
    if (!id) return ''
    const baked = typeof VITE_FILES_BASE_URL !== 'undefined' ? VITE_FILES_BASE_URL : ''
    const base = (runtimeEnv('FILES_BASE_URL', baked) || 'https://files.shopik.co.il').replace(/\/+$/, '')
    const cleanKey = String(key || '').replace(/^\/+|\/+$/g, '')
    return `${base}/images/products/${id}/${cleanKey ? `${cleanKey}/` : ''}${size}.webp`
}

// Main image lives at the flat path; alternates follow the GS1 writer
// convention (server/services/gs1/images.js): alt-1, alt-2, ... in entry order.
export function getProductImageUrls(id, images = [], size = 's') {
    let alternates = 0
    return (images || []).map(image => {
        if (image?.main) return getProductImageUrl(id, size)
        alternates += 1
        return getProductImageUrl(id, size, `alt-${alternates}`)
    })
}
