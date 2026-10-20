import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router'
import apiReq from '#common/functions/apiReq'
import Loader from '#common/components/Loader'
import Flex from '#common/components/Flex'
import Text from '#common/components/Text'
import ProductCard from 'pages/Products/ProductCard'
import { usePage } from 'layout/Page'
import { useAppData } from 'App'
import { useText } from '#common/texts/TextProvider'
import styles from 'pages/Products/products.module.css'
import { setSalesCache } from '#common/functions/salesCache.js'

const LIMIT = 30
function unwrapSearchRes(res) {
    if (Array.isArray(res)) return { products: res, sales: {} }
    return { products: res?.products || [], sales: res?.sales || {} }
}

export default function Search() {
    const { TR } = useText()
    const [searchParams] = useSearchParams()
    const q = (searchParams.get('q') || '').trim()
    const { pageData } = usePage()
    const { settings } = useAppData() || {}
    const latestRequest = useRef(0)
    const moreReqId = useRef(0)
    const seeded = useRef(pageData?.q === q && Array.isArray(pageData?.results))
    const [results, setResults] = useState(() => (seeded.current ? pageData.results : undefined))
    const [extra, setExtra] = useState([])
    const [hasMore, setHasMore] = useState(false)
    const [loading, setLoading] = useState(false)
    const [loadingMore, setLoadingMore] = useState(false)
    const sentinelRef = useRef(null)

    const allResults = results ? [...results, ...extra] : undefined

    useEffect(() => {
        if (seeded.current) {
            seeded.current = false
            setHasMore((pageData?.results?.length || 0) === LIMIT)
            if (pageData?.sales) setSalesCache(pageData.sales)
            return
        }
        if (q.length < 2) {
            setResults(undefined)
            setExtra([])
            setHasMore(false)
            return
        }

        ++moreReqId.current
        const currentRequest = ++latestRequest.current
        setLoading(true)
        apiReq('product/search', { value: q, limit: LIMIT })
            .then(res => {
                const { products, sales } = unwrapSearchRes(res)
                if (sales && Object.keys(sales).length) setSalesCache(sales)
                if (currentRequest === latestRequest.current) {
                    setResults(products)
                    setExtra([])
                    setHasMore(products.length === LIMIT)
                }
            })
            .catch(() => {
                if (currentRequest === latestRequest.current) setResults([])
            })
            .finally(() => {
                if (currentRequest === latestRequest.current) setLoading(false)
            })
    }, [q])

    async function loadMore() {
        if (loadingMore || !hasMore || !results) return
        const reqId = ++moreReqId.current
        setLoadingMore(true)
        try {
            const res = await apiReq('product/search', { value: q, limit: LIMIT, skip: results.length + extra.length })
            const { products, sales } = unwrapSearchRes(res)
            if (sales && Object.keys(sales).length) setSalesCache(sales)
            if (reqId !== moreReqId.current) return
            setExtra(prev => [...prev, ...products])
            setHasMore(products.length === LIMIT)
        } catch {
            if (reqId === moreReqId.current) setHasMore(false)
        } finally {
            if (reqId === moreReqId.current) setLoadingMore(false)
        }
    }

    useEffect(() => {
        const el = sentinelRef.current
        if (!el || !hasMore) return
        const io = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting) loadMore()
        }, { rootMargin: '400px' })
        io.observe(el)
        return () => io.disconnect()
    }, [hasMore, loadingMore, q])

    useEffect(() => {
        document.title = `${settings?.appearance?.siteName?.trim() || 'Shopik'} | ${q ? `${TR('search_results_title')}: ${q}` : TR('search')}`
    }, [q, loading, settings])

    return <Flex col className={styles.products} direction='column' gap={10}>
        <Text size='h1' bold>{q ? `${TR('search_results_title')}: ${q}` : TR('search')}</Text>
        <div className={styles.list}>
            {loading ? <Loader /> : allResults?.length
                ? allResults.map(p => <ProductCard key={p.id} product={p} />)
                : (results ? <Text mode='sub'>{TR('no_search_results')}</Text> : null)}
        </div>
        {!loading && hasMore && <div ref={sentinelRef} className={styles.sentinel} />}
        {loadingMore && <Loader />}
    </Flex>
}

Search.init = async function (url) {
    const q = new URL(url, 'http://localhost').searchParams.get('q')?.trim() || ''
    let results = []
    let sales = {}
    if (q.length >= 2) {
        const res = await apiReq('product/search', { value: q, limit: LIMIT }).catch(() => [])
        const unwrapped = unwrapSearchRes(res)
        results = unwrapped.products
        sales = unwrapped.sales
    }
    return {
        title: q,
        q,
        results,
        sales
    }
}
