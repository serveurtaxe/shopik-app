import { StaticRouter, matchPath } from 'react-router'
import { renderToString } from 'react-dom/server'
import Head from 'layout/Head'
import TR from '#common/texts/TR.js'
import { getSettingFileUrl } from '#common/functions/settingFileUrl.js'
import { buildMeta } from '#common/functions/buildMeta.js'
import { resolveGlassixConfig } from '#common/functions/glassix.js'
import { resolveVeeConfig } from '#common/functions/vee.js'
import { getPwaIconUrl, PWA_ICON_FILES } from '#common/functions/pwaIconUrl.js'
import pages from './pages'
import App from './App'

const DEFAULT_THEME_COLOR = '#195855'

// Theme values are either plain strings (seedMenuColors) or { light, dark }.
function colorOf(value, fallback) {
  const color = typeof value === 'string' ? value : value?.light
  return typeof color === 'string' && color.trim() ? color.trim() : fallback
}

export async function render({ url, data, ctx }) {
  const pathname = url.split('?')[0]
  const page = pages.find(p => matchPath(p.path, pathname))
  let notFound = !page
  data.initData = notFound ? { notFound: true } : await page.element.init?.(url, ctx)
  if (data.initData?.notFound) notFound = true
  data.url = url

  const html = renderToString(
    <StaticRouter location={url}>
      <App data={data} />
    </StaticRouter>
  )

  const appearance = data?.settings?.appearance || {}
  const theme = data?.settings?.theme || {}
  const siteName = String(appearance.siteName || '').trim() || 'Shopik'
  // Browser tab keeps the favicon; installed apps use the dedicated appIcon.
  const faviconUrl = getSettingFileUrl(appearance.favicon) || '/icons/icon-192.png'
  const faviconDarkUrl = getSettingFileUrl(appearance.faviconDark) || undefined
  const appleTouchUrl = getPwaIconUrl(appearance.appIcon, PWA_ICON_FILES.apple180) || '/icons/apple-180.png'
  const themeColor = colorOf(theme['header-bg'], colorOf(theme['product-button-bg'], DEFAULT_THEME_COLOR))
  const meta = buildMeta({ settings: data.settings, initData: data.initData, page, notFound, url, host: ctx?.host })
  // Same gate the storefront loader uses: null unless the domain has a
  // fully-filled, enabled glassix config, so the head never preconnects to
  // Glassix for a store that does not load the widget.
  const glassix = resolveGlassixConfig(data.settings)
  // Same gate the Vee widget component uses (production + enabled + sitekey),
  // so the head never preconnects for a store that does not load the widget.
  const vee = resolveVeeConfig(data.settings, data.env)

  let head = renderToString(<Head
    title={meta.title || (notFound ? `${siteName} | ${TR('page_not_found')}` : siteName)}
    description={meta.description}
    noindex={notFound}
    favicon={faviconUrl}
    faviconDark={faviconDarkUrl}
    appleTouchIcon={appleTouchUrl}
    themeColor={themeColor}
    appTitle={siteName}
    meta={meta}
    glassix={glassix}
    vee={vee}
    gtmId={data?.settings?.seo?.gtmId}
  />)

  const themeEntries = Object.entries(data?.settings?.theme || {})
  const lightVars = []
  const darkVars = []
  // Sanitize theme keys/values: keys must be valid CSS custom-property
  // names, values must not break out of <style> (admin-controlled settings
  // are rendered unescaped into the SSR head).
  const safeKey = (k) => /^[a-zA-Z0-9-]+$/.test(k) ? k : null
  const safeVal = (v) => typeof v === 'string' && !/[<>"';{}]/.test(v) ? v : null
  for (const [key, value] of themeEntries) {
    if (!safeKey(key)) continue
    if (value && typeof value === 'object' && !Array.isArray(value) && ('light' in value || 'dark' in value)) {
      const light = safeVal(value.light)
      const dark = value.dark !== undefined ? safeVal(value.dark) : light
      if (light) lightVars.push(`--${key}:${light};`)
      if (dark) darkVars.push(`--${key}:${dark};`)
      else if (light) darkVars.push(`--${key}:${light};`)
    } else {
      const v = safeVal(value)
      if (v) lightVars.push(`--${key}:${v};`)
    }
  }

  const lightCss = lightVars.join('')
  const darkCss = darkVars.join('')
  head += `<style>:root{${lightCss}}${darkCss ? `:root[data-theme=dark]{${darkCss}}` : ''}</style>`

  return {
    html,
    head,
    status: notFound ? 404 : 200
  }
}
