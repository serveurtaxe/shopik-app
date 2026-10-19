import storage from '#server/external/storage.js'
import download from '#server/services/image/download.js'
import resize from '#server/services/image/resize.js'
import { buildDisplayObjectPath } from '#server/services/image/paths.js'
import { BANNER_SIZES } from '#server/services/image/constants.js'
import uid from '#common/functions/uid.js'
import { sha1 } from '#server/utils/data/displayBlocks.js'

const MAX_BYTES = 8 * 1024 * 1024

// Upload one banner slide image through the standard pipeline
// (download → sharp webp variants → GCS), accepting either a pasted URL or a
// base64 file upload. Both end up as files in our bucket.
// Stores/returns only the RELATIVE base path — the client prepends
// VITE_FILES_BASE_URL (see common/functions/displayImageUrl.js).
export default async function upload_image(payload) {
    const { imageBase64, sourceUrl, blockId, slideKey, variant } = payload
    if (!imageBase64 && !sourceUrl)
        throw { status: 400, message: 'imageBase64 or sourceUrl required' }
    // Separate folders per slot so the desktop and mobile uploads for one slide
    // don't overwrite each other (both share the same slideKey).
    const slot = variant === 'mobile' ? 'mobile' : 'desktop'

    let buffer
    if (imageBase64) {
        try {
            buffer = Buffer.from(String(imageBase64).split(',').pop(), 'base64')
        } catch {
            throw { status: 400, message: 'invalid image' }
        }
    } else {
        buffer = await download(sourceUrl)
    }
    // Single post-decode check (base64 inflates ~33%, so string-length checks lie).
    if (!buffer?.length || buffer.length > MAX_BYTES)
        throw { status: 400, message: 'image too large' }

    let sizes
    try {
        sizes = await resize(buffer, BANNER_SIZES)
    } catch {
        throw { status: 400, message: 'invalid image' }
    }
    const blockDir = blockId || `tmp-${uid()}`
    const key = slideKey || uid()
    const basePath = `images/display-blocks/${blockDir}/${key}/${slot}`

    await Promise.all(
        Object.entries(sizes).map(([name, data]) =>
            storage.uploadFile({
                path: buildDisplayObjectPath(blockDir, key, name, slot),
                data,
                contentType: 'image/webp',
                cacheControl: 'public, max-age=31536000, immutable'
            })
        )
    )

    return { basePath, sizes: Object.keys(sizes), hash: sha1(buffer) }
}

upload_image.config = {
    permissions: ['display_block:create', 'display_block:update']
}
