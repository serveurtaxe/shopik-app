import { StaticRouter, matchPath } from 'react-router'
import { renderToString } from 'react-dom/server'
import Head from 'layout/Head'
import TR from '#common/texts/TR.js'
import { getSettingFileUrl } from '#common/functions/settingFileUrl.js'
import pages from './pages'
import App from './App'

export async function render({ url, data }) {
  const pathname = url.split('?')[0]
  const page = pages.find(p => matchPath(p.path, pathname))
  let notFound = !page
  data.initData = notFound ? { notFound: true } : await page.element.init?.(url)
  if (data.initData?.notFound) notFound = true
  data.url = url

  const html = renderToString(
    <StaticRouter location={url}>
      <App data={data} />
    </StaticRouter>
  )

  let head = renderToString(<Head
    title={`${data.settings?.appearance?.siteName?.trim() || 'Shopik'} | ${notFound ? TR('page_not_found') : data.initData?.title || page?.title || ''}`}
    description={notFound ? '' : data.initData?.description || page?.description || ''}
    noindex={notFound}
    favicon={getSettingFileUrl(data?.settings?.appearance?.favicon) || undefined}
    faviconDark={getSettingFileUrl(data?.settings?.appearance?.faviconDark) || undefined}
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
