import { GLASSIX_ORIGINS } from 'common/functions/glassix.js'

export default function Head({
    title = '',
    description = '',
    noindex = false,
    favicon,
    faviconDark,
    appleTouchIcon,
    themeColor,
    appTitle,
    meta,
    glassix,
    vee,
    gtmId
}) {
    const appleIcon = appleTouchIcon || favicon
    return <>
        <title>{title}</title>
        <meta name='description' content={description} />
        {meta && <>
            {meta.title && <meta property="og:title" content={meta.title} />}
            {meta.description && <meta property="og:description" content={meta.description} />}
            {meta.image && <meta property="og:image" content={meta.image} />}
            {meta.image && meta.imageType && <meta property="og:image:type" content={meta.imageType} />}
            {meta.image && meta.imageWidth && <meta property="og:image:width" content={String(meta.imageWidth)} />}
            {meta.image && meta.imageHeight && <meta property="og:image:height" content={String(meta.imageHeight)} />}
            {meta.url && <meta property="og:url" content={meta.url} />}
            {meta.type && <meta property="og:type" content={meta.type} />}
            {meta.siteName && <meta property="og:site_name" content={meta.siteName} />}
            {meta.twitterCard && <meta name="twitter:card" content={meta.twitterCard} />}
            {meta.title && <meta name="twitter:title" content={meta.title} />}
            {meta.description && <meta name="twitter:description" content={meta.description} />}
            {meta.image && <meta name="twitter:image" content={meta.image} />}
        </>}
        {noindex && <meta name='robots' content='noindex' />}
        {themeColor && <meta name='theme-color' content={themeColor} />}
        {appTitle && <meta name='apple-mobile-web-app-title' content={appTitle} />}
        {favicon && <link rel="icon" href={favicon} />}
        {faviconDark && <link rel="icon" href={faviconDark} media="(prefers-color-scheme: dark)" />}
        {appleIcon && <link rel="apple-touch-icon" href={appleIcon} />}
        {/* Only for domains with Glassix fully enabled, so a store that never
            opted in neither opens a socket to Glassix nor shows up in Lighthouse
            as an unused preconnect. No crossOrigin: the widget script is fetched
            in non-CORS mode (see client/features/Glassix/loader.js), and a
            CORS-mode preconnect would warm a socket pool the fetch never reuses.
            The widget itself still loads after `load` — this only pays for the
            DNS/TLS handshake in the gap that deferral leaves open. */}
        {glassix && GLASSIX_ORIGINS.map(origin =>
            <link key={origin} rel="preconnect" href={origin} />)}
        {/* Same gate as the widget itself: a production run plus an enabled,
            fully-filled integrations.vee setting (common/functions/vee.js).
            The script is fetched after `load`, so this only pays for the
            DNS/TLS handshake in the gap that deferral leaves open; a store
            without Vee never opens a socket to them. */}
        {vee && <link rel="preconnect" href={vee.access} />}
        {/* GTM – async script loaded via SSR when the admin has set a GTM ID
            in Settings > SEO. The async attribute keeps it non-render-blocking.
            dns-prefetch warms the connection early without hurting Lighthouse. */}
        {gtmId && <>
            <link rel="dns-prefetch" href="https://www.googletagmanager.com" />
            <script async src={`https://www.googletagmanager.com/gtm.js?id=${gtmId}`} />
            <script dangerouslySetInnerHTML={{ __html:
                `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());`
            }} />
        </>}
    </>
}
