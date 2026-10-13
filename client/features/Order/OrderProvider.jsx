import { createContext, useContext, useEffect, useState, useRef } from 'react'
import { useAppData } from 'App'
import apiReq from '#common/functions/apiReq.js'
import { getSalesCache, setSalesCache } from '#common/functions/salesCache.js'

export const CART_SYNC_DEBOUNCE_MS = 300

const OrderContext = createContext({})
export const useOrder = () => useContext(OrderContext)

const readStoredCart = () => {
    try {
        if (typeof localStorage === 'undefined') return undefined
        const raw = localStorage.cart
        if (!raw) return undefined
        const cart = JSON.parse(raw)
        return Array.isArray(cart) ? cart : undefined
    } catch {
        return undefined
    }
}

export default function OrderProvider({ children }) {
    const { order: serverOrder } = useAppData()
    const hasServerOrder = !!serverOrder
    const [order, setOrder] = useState(hasServerOrder ? serverOrder : {})
    // Domain pricing is resolved server-side into a flat `price` — the client
    // carries no domain logic. The server re-resolves the domain per request
    // (router middleware), so sync payloads need no domainId either.
    const seqRef = useRef(0)
    const timersRef = useRef(new Map())
    const pendingRef = useRef(new Map())
    const queueRef = useRef(Promise.resolve())
    const unconfirmedRef = useRef(new Map())

    const queueCartSync = (product, amount) => {
        const id = product?.id
        if (!id) return
        unconfirmedRef.current.set(id, amount)
        pendingRef.current.set(id, { product, amount })
        if (timersRef.current.has(id)) clearTimeout(timersRef.current.get(id))
        const tid = setTimeout(() => {
            const pending = pendingRef.current.get(id)
            if (!pending) return
            pendingRef.current.delete(id)
            timersRef.current.delete(id)
            const seq = ++seqRef.current
            const task = () => apiReq('order/cart/product', { id: pending.product.id, amount: pending.amount })
                .then(({ order: serverOrder, sales }) => {
                    if (sales) setSalesCache(sales)
                    const cur = unconfirmedRef.current.get(pending.product.id)
                    if (cur === pending.amount) unconfirmedRef.current.delete(pending.product.id)
                    const hasPending = unconfirmedRef.current.size > 0 || timersRef.current.size > 0
                    if (hasPending) return
                    if (seq === seqRef.current && serverOrder) setOrder(serverOrder)
                }).catch(() => {
                    const cur = unconfirmedRef.current.get(pending.product.id)
                    if (cur === pending.amount) unconfirmedRef.current.delete(pending.product.id)
                })
            queueRef.current = queueRef.current.then(task, task)
        }, CART_SYNC_DEBOUNCE_MS)
        timersRef.current.set(id, tid)
    }

    useEffect(() => () => {
        for (const tid of timersRef.current.values()) clearTimeout(tid)
        timersRef.current.clear()
    }, [])

    useEffect(() => {
        if (hasServerOrder) return
        const cart = readStoredCart()
        if (!cart?.length) return
        setOrder({ cart })
        // Device-restored guest cart: recreate the server guest cart so sums,
        // sales and shipping come from the server. Display fallbacks cover
        // the gap until the responses arrive; failures keep the fallback.
        for (const item of cart) {
            const amount = Number(item?.amount) || 0
            if (item?.id && amount > 0) queueCartSync(item, amount)
        }
    }, [hasServerOrder])

    useEffect(() => {
        if (order?.cart) localStorage.cart = JSON.stringify(order.cart)
    }, [order])

    // Warm sales cache for existing cart items (fixes optimistic jump when sale missing)
    useEffect(() => {
        const cart = order?.cart || []
        if (!cart.length) return
        const saleIds = [...new Set(cart.flatMap(i => i.saleIds || []))]
        if (!saleIds.length) return
        const cache = getSalesCache()
        const missing = saleIds.filter(id => !cache[id])
        if (!missing.length) return
        const productIds = [...new Set(cart.map(i => i.id).filter(Boolean))]
        if (!productIds.length) return
        apiReq('product/get', { filter: { id: { $in: productIds } }, limit: productIds.length }).then(res => {
            if (res?.sales) setSalesCache(res.sales)
        }).catch(() => { })
    }, [order?.cart])

    return <OrderContext value={{ order, setOrder, queueCartSync }}>
        {children}
    </OrderContext>
}   