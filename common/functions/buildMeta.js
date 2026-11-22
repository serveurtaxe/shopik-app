// Assemble Open Graph + Twitter card values for the SSR head (social
// crawlers read the server-rendered HTML only). Precedence per field:
// per-page content (Page.init results) > the domain's public `seo`
// settings > the route table > appearance settings.
// The description is the one field that never varies per page: cards show the
// store-wide seo.seoDescription, so the title/image carry the page identity.
import { getSettingFileUrl } from './settingFileUrl.js'
import { getPwaIconUrl, PWA_ICON_FILES } from './pwaIconUrl.js'

// og:image:type from the extension every stored image URL carries. Unknown
// shapes (data: URLs) emit nothing rather than a wrong MIME type.
function imageMimeType(url) {
    const ext = String(url || '').split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
    if (ext === 'webp') return 'image/webp'
    if (ext === 'png') return 'image/png'
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
    if (ext === 'gif') return 'image/gif'
    return ''
}

export function buildMeta({ settings, initData, page, notFound, url, host } = {}) {
    const seo = settings?.seo || {}
    const appearance = settings?.appearance || {}
    const pathname = String(url || '').split('?')[0]
    // ogImage uploads store the exact variant file, which getSettingFileUrl
    // returns as-is. Older values are a base dir containing l/m/s, so 'l'
    // resolves both shapes (and is the ogImage setting's full-res variant).
    const ogImage = getSettingFileUrl(seo.ogImage, 'l')
    const image = notFound
        ? ''
        : (initData?.image
            || ogImage
            || getPwaIconUrl(appearance.appIcon, PWA_ICON_FILES.icon512)
            || getSettingFileUrl(appearance.logo))
    // Only the uploaded seo.ogImage has a size captured with it; product/page
    // images and appearance fallbacks have no recorded dimensions.
    const ogImageSize = image && image === ogImage
        ? settings?.__imageSize?.['seo.ogImage']
        : null
    // Cards show "siteName | page name" (mirrors the document <title>).
    const pageTitle = notFound ? '' : (initData?.title || page?.title || '')
    const title = notFound ? '' : [appearance.siteName, pageTitle].filter(Boolean).join(' | ')
    return {
        title,
        description: notFound ? '' : (seo.seoDescription || ''),
        image,
        imageType: notFound ? '' : imageMimeType(image),
        imageWidth: ogImageSize?.width || '',
        imageHeight: ogImageSize?.height || '',
        url: host ? `https://${host}${pathname.startsWith('/') ? pathname : `/${pathname}`}` : '',
        type: notFound ? '' : (initData?.metaType || seo.ogType || 'website'),
        siteName: appearance.siteName || '',
        twitterCard: notFound ? '' : (seo.twitterCard || (image ? 'summary_large_image' : 'summary'))
    }
}
