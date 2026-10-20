import Input from '#common/components/Input/index.jsx'
import Icon from '#common/components/Icon/index.jsx'
// import Button from '#common/components/Button'
import Loader from '#common/components/Loader'
import Flex from '#common/components/Flex'
import Text from '#common/components/Text'
import ProductInline from 'layout/Cart/ProductInline'
import { useText } from '#common/texts/TextProvider'
import { useNavigate, Link } from 'react-router'
import { useEffect, useRef, useState } from 'react'
import apiReq from '#common/functions/apiReq'
import { setSalesCache } from '#common/functions/salesCache.js'
import styles from './search.module.css'

export default function Search({ }) {
    const { TR } = useText()
    const navigate = useNavigate()
    const rootRef = useRef(null)
    const latestRequest = useRef(0)
    const [value, setValue] = useState('')
    const [results, setResults] = useState()
    const [loading, setLoading] = useState(false)
    const [open, setOpen] = useState(false)

    const trimmed = value.trim()
    const showResults = open && trimmed.length >= 2

    useEffect(() => {
        if (trimmed.length < 2) {
            setResults()
            setLoading(false)
            return
        }

        const currentRequest = ++latestRequest.current
        setLoading(true)

        const debounceId = setTimeout(() => {
            apiReq('product/search', { value: trimmed, limit: 10 })
                .then(res => {
                    const products = Array.isArray(res) ? res : (res?.products || [])
                    const sales = Array.isArray(res) ? null : res?.sales
                    if (sales && typeof sales === 'object' && Object.keys(sales).length) setSalesCache(sales)
                    if (currentRequest === latestRequest.current) setResults(products)
                })
                .catch(() => {
                    if (currentRequest === latestRequest.current) setResults([])
                })
                .finally(() => {
                    if (currentRequest === latestRequest.current) setLoading(false)
                })
        }, 300)

        return () => clearTimeout(debounceId)
    }, [trimmed])

    useEffect(() => {
        function onOutside(e) {
            if (!rootRef.current?.contains(e.target)) setOpen(false)
        }
        function onKey(e) {
            if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onOutside)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('mousedown', onOutside)
            document.removeEventListener('keydown', onKey)
        }
    }, [])

    function onInput(e) {
        setValue(e?.target ? e.target.value : e)
        setOpen(true)
    }

    function onKeyDown(e) {
        if (e.key !== 'Enter') return
        const q = e.target.value.trim()
        if (q.length < 2) return
        setOpen(false)
        e.target.blur()
        navigate(`/search?q=${encodeURIComponent(q)}`)
    }

    return <div className={styles.search} ref={rootRef}>
        <div className={styles.inputWrapper}>
            <Icon name='search' className={styles.searchIcon} />
            <input
                className={styles.searchInput}
                placeholder={TR?.('main_search_placeholder')}
                type='search'
                value={value}
                onChange={onInput}
                onKeyDown={onKeyDown}
                onFocus={() => setOpen(true)}
            />
            {/* hidden for now
            <Button
                mode='text'
                icon='filter'
                className={styles.filterBtn}
                aria-label={TR?.('aria_filter')}
            //tooltip={TR?.('aria_filter')}
            />
            */}
        </div>
        {showResults && <div className={styles.results}>
            {loading ? <Flex center className={styles.state}><Loader /></Flex> : (
                results?.length ? results.map(product => (
                    <Link
                        key={product.id}
                        to={`/product/${product.id}`}
                        state={{ product }}
                        className={styles.result}
                        onClick={() => setOpen(false)}
                    >
                        <ProductInline product={product} remove={false} note={false} />
                    </Link>
                )) : <Text mode='sub' className={styles.state}>{TR('no_search_results')}</Text>
            )}
        </div>}
    </div>
}
