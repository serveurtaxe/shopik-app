import { useLocation, useParams, matchPath } from 'react-router'
import pages from 'pages'
import { useAppData } from 'App'
import { useEffect, useState } from 'react'

export function usePage(initialData) {
    const { pathname } = useLocation()
    const params = useParams()
    const appData = useAppData()
    const page = pages.find(p =>
        matchPath({ path: p.path, end: true }, pathname)
    )
    // SSR initData belongs to the landing URL only. Reusing it for a different
    // path (client-side nav mounts a fresh component) flashes the landing
    // page's content — e.g. home banners on every page.
    const ssrUrl = (appData.url || '').split('?')[0]
    const isSsrPath = !!ssrUrl && decodeURIComponent(ssrUrl) === decodeURIComponent(pathname)
    const [data, setData] = useState(initialData || (isSsrPath ? appData.initData : null) || {})
    const [loading, setLoading] = useState(!initialData && !isSsrPath)

    useEffect(() => {
        if (initialData) {
            if (data.prevPath !== pathname) {
                setData({ ...initialData, prevPath: pathname })
            }
            return
        }
        if ((data.prevPath || appData.url) !== pathname) {
            setLoading(true)
            page.element.init?.(decodeURI(pathname))
                .then(pageData => {
                    pageData.prevPath = pathname
                    setData(pageData)
                    document.title = `${appData.settings?.appearance?.siteName?.trim() || 'Shopik'} | ${pageData.title}`
                    document.querySelector("meta[name='description']")
                        ?.setAttribute('content', pageData.description || '')
                })
                .catch(() => setData({ notFound: true, title: '404', prevPath: pathname }))
                .finally(() => setLoading(false))
        }
    }, [page.path, params, pathname, initialData])

    return {
        page,
        params,
        pageData: data,
        loading,
        path: decodeURIComponent(pathname)
    }
}   
