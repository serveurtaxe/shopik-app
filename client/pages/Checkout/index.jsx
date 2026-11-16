import { useState, useEffect, useCallback } from 'react'
import { useOrder } from 'features/Order/OrderProvider'
import { useUser } from 'features/User'
import { useNavigate } from 'react-router'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Collapse from 'common/components/Collapse'
import ProductInline from 'layout/Cart/ProductInline'
import OrderSummary from './OrderSummary'
import CheckoutSuccess from './CheckoutSuccess'
import styles from './checkout.module.css'
import { useText } from 'common/texts/TextProvider'
import apiReq from 'common/functions/apiReq'
import Loader from 'common/components/Loader'
import { useAppData } from 'App'
import { useMemo, useRef } from 'react'
import { checkoutDisplayTotal } from 'common/functions/cartTotals.js'
import { extractLimits, getMinSumForMethod, getRemainingToMin } from '#common/functions/limits.js'
import useMediaQuery from 'common/functions/useMediaQuery'
import render from '#common/functions/render.js'
import { isElevatorRequired } from '#common/functions/address.js'
import { isHoldExpired } from 'features/Order/windowHold'

export default function Checkout() {
    const { order = {}, setOrder, refreshCart } = useOrder()
    const user = useUser()
    const { TR } = useText() || {}
    const navigate = useNavigate()
    const [paymentUrl, setPaymentUrl] = useState()
    const [paying, setPaying] = useState(false)
    const [payError, setPayError] = useState()
    const [missingFields, setMissingFields] = useState([])
    const [doneOrder, setDoneOrder] = useState(null)

    const cart = order?.cart || []
    const totalItemsCount = cart.reduce((acc, item) => acc + (item.amount || item.units || 1), 0)
    const { settings } = useAppData?.() || {}
    const limits = useMemo(() => extractLimits(settings), [settings])
    const minSumThreshold = getMinSumForMethod(limits, order?.deliveryMethod)
    const minSumRemaining = getRemainingToMin({ sum: order?.sum ?? 0, deliveryMethod: order?.deliveryMethod, limits })
    const isBelowMinSum = minSumThreshold > 0 && minSumRemaining > 0
    const serviceAddress = user?.addresses?.find(a => a.active) || user?.addresses?.[0]
    const isDelivery = (order?.deliveryMethod || 'delivery') !== 'pickup'
    const hasNoService = isDelivery && serviceAddress?.hasService === false
    const deliveryAddress = order?.address?.city ? order.address : serviceAddress
    const hasElevatorIssue = isDelivery && isElevatorRequired(deliveryAddress)

    const cartTitle = `${TR('my_cart_title')} (${totalItemsCount} ${TR('items_suffix')})`
    // Viewport flag for content decisions only; layout direction stays
    // pure CSS so SSR and client render identical markup.
    const isMobile = useMediaQuery('(max-width: 900px)')
    // Mobile payment view: summary card hidden, title pinned to page top
    const mobilePayment = isMobile && (paying || paymentUrl)

    function getLocalMissing() {
        const isNonEmpty = (v) => typeof v === 'string' && v.trim().length > 0
        const missing = []
        const hasOrderName = order?.name && isNonEmpty(order.name.first) && isNonEmpty(order.name.last)
        const hasUserName = user?.name && isNonEmpty(user.name.first) && isNonEmpty(user.name.last)
        if (!hasOrderName && !hasUserName) missing.push('name')
        if (!isNonEmpty(order?.email) && !isNonEmpty(user?.email)) missing.push('email')
        if (!isNonEmpty(order?.phone) && !isNonEmpty(user?.phone)) missing.push('phone')
        const deliveryMethod = order?.deliveryMethod || 'delivery'
        const isPickup = deliveryMethod === 'pickup'
        if (isPickup) {
            const hasPickup = order?.storeId || (order?.address && isNonEmpty(order.address.city))
            if (!hasPickup && !user?.pickupStoreId) missing.push('address')
        } else if (hasNoService || hasElevatorIssue) {
            missing.push('address')
        } else {
            const addr = order?.address
            const hasDelivery = addr && isNonEmpty(addr.city) && isNonEmpty(addr.street) && addr.building != null && String(addr.building).trim() !== ''
            if (!hasDelivery) {
                const activeAddr = user?.addresses?.find(a => a.active) || user?.addresses?.[0]
                const hasCandidate = activeAddr && isNonEmpty(activeAddr.city) && isNonEmpty(activeAddr.street) && activeAddr.building != null && String(activeAddr.building).trim() !== ''
                if (!hasCandidate) missing.push('address')
            }
        }
        if (!order?.window || !order.window.id || !order.window.date) missing.push('window')
        else if (isHoldExpired(order.window)) missing.push('window')
        const invoice = order?.invoiceRequest
        if (invoice?.required && !String(invoice.taxId || '').trim()) missing.push('invoice')
        return missing
    }
    useEffect(() => {
        if (!user?.id) navigate('/')
        else if (!order?.cart || !order.cart.length) navigate('/')
    }, [user, order?.cart])
    // Reconcile with the server when the customer reaches checkout: the cart
    // in client state can be optimistic or stale (debounced edit, another
    // tab/device) while the payment charges the server order.
    useEffect(() => {
        if (user?.id) refreshCart()
    }, [refreshCart, user?.id])
    // Expired hold (or passed lead time on a legacy cart): drop the window
    // locally and let the summary open the window section for a new choice.
    const clearWindow = useCallback(() => {
        setOrder(prev => {
            if (!prev?.window) return prev
            const { window: _w, ...rest } = prev
            return rest
        })
        setMissingFields(prev => (prev.includes('window') ? prev : [...prev, 'window']))
    }, [setOrder])

    useEffect(() => {
        if (!order?.window?.id) return
        if (isHoldExpired(order.window)) clearWindow()
    }, [order?.window?.id, order?.window?.holdUntil, order?.window?.reservedAt, order?.window?.leadTimestamp, clearWindow])

    // The callback moves the order to 'paid' before it posts its success
    // message or redirects back, so the server is authoritative: anything it
    // does not confirm must never render the success page — a blocked or
    // failed callback would otherwise look like a completed sale while the
    // order stays in 'cart'.
    async function confirmPaidOrder(orderNumber) {
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                const res = await apiReq('order/status', { orderNumber })
                const placedOrder = res?.order || res?.data
                const status = placedOrder?.status
                if (status && status !== 'cart' && status !== 'failed' && status !== 'canceled')
                    return placedOrder
            } catch { }
            await new Promise(r => setTimeout(r, 1000))
        }
        return null
    }

    // Listen for hyp callback postMessage (lightweight loader html) + fetch updated order
    const iframeRef = useRef(null)
    useEffect(() => {
        function onMessage(e) {
            const allowedOrigins = [window.location.origin, 'https://shopik.co.il']
            if (!allowedOrigins.includes(e.origin)) return
            const data = e.data || {}
            if (data.type !== 'hyp_callback') return
            if (data.ok && data.orderNumber) {
                // verify via API — success only once the server moved the order out of cart
                confirmPaidOrder(data.orderNumber).then(placedOrder => {
                    if (placedOrder) {
                        setDoneOrder(placedOrder?.id ? placedOrder : { ...order, number: data.orderNumber })
                        setPaymentUrl(null)
                    } else {
                        setPayError({ message: TR?.('payment_status_unconfirmed') })
                        setPaymentUrl(null)
                    }
                })
            } else if (data.ok === false) {
                setPayError({ message: data.error || 'payment_failed_generic' })
                setPaymentUrl(null)
            }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
    }, [order])

    function handleIframeLoad(e) {
        try {
            const loc = e.target.contentDocument?.location
            if (!loc) return
            const href = loc.href || ''
            const search = loc.search || ''
            // fallback if postMessage missed - check query for Order/CCode,
            // but confirm the order actually left 'cart' before showing success
            if (href.includes('hyp/callback') || href.includes('success') || search.includes('CCode=')) {
                const params = new URLSearchParams(search)
                const orderNumber = params.get('Order') || params.get('order')
                const ccode = params.get('CCode') ?? params.get('Ccode')
                const isOk = ccode === '0' || ccode === '700'
                if (isOk && orderNumber) {
                    confirmPaidOrder(orderNumber).then(placedOrder => {
                        if (!placedOrder) {
                            setPayError(prev => prev || { message: TR?.('payment_status_unconfirmed') })
                            setPaymentUrl(null)
                            return
                        }
                        setDoneOrder(prev => prev || (placedOrder?.id ? placedOrder : { ...order, number: orderNumber }))
                        setPaymentUrl(null)
                    })
                }
            }
        } catch { }
    }

    async function handlePayment() {
        if (paying) return
        setPayError()
        if (hasNoService || hasElevatorIssue) {
            setMissingFields(['address'])
            if (hasElevatorIssue) setPayError({ message: TR?.('address_elevator_required') })
            return
        }
        if (isBelowMinSum) {
            const label = TR?.('minimum_order_sum')
            setPayError({ message: `${label} ${minSumThreshold}` })
            return
        }
        // Client-side pre-validation: if we already know fields are missing, open them and don't hit server
        const localMissing = getLocalMissing()
        if (localMissing.length) {
            setMissingFields(localMissing)
            if (localMissing.includes('window')) clearWindow()
            return
        }
        setPaying(true)
        setMissingFields([])
        try {
            // Charge only what the customer was shown: flush edits still in the
            // debounce window, pull the authoritative cart, and refuse to start
            // a payment for a total higher than the one on screen.
            const expectedAmount = checkoutDisplayTotal(order)
            const freshOrder = await refreshCart()
            if (freshOrder && checkoutDisplayTotal(freshOrder) > expectedAmount + 0.01) {
                setPayError({ message: TR?.('cart_changed_confirm') })
                return
            }
            const res = await apiReq('payment/create', {
                orderId: freshOrder?.id || order.id,
                expectedAmount,
                invoiceRequest: order.invoiceRequest
            })
            if (res?.holdUntil) {
                // Checkout extends the hold once so the payment has time to finish.
                setOrder(prev => prev?.window
                    ? { ...prev, window: { ...prev.window, holdUntil: res.holdUntil } }
                    : prev)
            }
            if (res?.paymentUrl) setPaymentUrl(res.paymentUrl)
        } catch (e) {
            console.error('payment create failed:', e)
            if (e?.code === 'CART_CHANGED') {
                await refreshCart()
                setPayError({ message: TR?.('cart_changed_confirm') })
                return
            }
            setPayError(e)
            const fields = e?.missingFields || e?.data?.missingFields || []
            if (Array.isArray(fields) && fields.length) {
                // trigger auto-open one-by-one (OrderSummary watches this array)
                setMissingFields(fields)
                if (fields.includes('window')) clearWindow()
            }
        } finally {
            setPaying(false)
        }
    }

    if (doneOrder) {
        return <CheckoutSuccess order={doneOrder} />
    }

    return user?.id && (
        <div className={`${styles.checkoutPage} ${mobilePayment ? styles.payingMobile : ''}`}>
            {mobilePayment && (
                <Text size='xxl' bold className={styles.mobilePaymentTitle}>
                    {TR?.('order_summary_title')?.replace('{orderNumber}', order?.number || '')}
                </Text>
            )}
            <div className={styles.container}>
                {/* Main Content Area (Start Side in RTL) */}
                <Flex col gap={16} grow={1} className={styles.mainContent}>
                    {paying ? (
                        <Flex center className={styles.paymentLoaderWrapper}>
                            <Loader size={40} />
                        </Flex>
                    ) : paymentUrl ? (
                        <div className={styles.paymentFrameWrapper}>
                            <iframe
                                ref={iframeRef}
                                src={paymentUrl}
                                title={TR?.('aria_payment')}
                                className={styles.paymentFrame}
                                allow='payment'
                                onLoad={handleIframeLoad}
                            />
                        </div>
                    ) : (
                        <div className={styles.cartOnly}>
                            {/* Accordion 1: Recommended Products */}
                            <Collapse
                                title={
                                    <Text bold size='xl'>
                                        products_especially_for_you
                                    </Text>
                                }
                                defaultOpen={false}
                            >
                                <div className={styles.recommendedContent}>
                                    <Text mode='sub'>no_recommended_products</Text>
                                </div>
                            </Collapse>

                            {/* Accordion 2: My Cart */}
                            <Collapse
                                title={
                                    <Text bold size='xl'>
                                        {cartTitle}
                                    </Text>
                                }
                                defaultOpen={true}
                            >
                                {cart.length === 0 ? (
                                    <Flex col gap={10} className={styles.emptyCart} center>
                                        <Text size='xl' bold>empty_cart_title</Text>
                                        <Text mode='sub'>empty_cart_subtitle</Text>
                                    </Flex>
                                ) : (
                                    <Flex col gap={12} className={styles.cartList}>
                                        {cart.map((item, idx) => (
                                            <ProductInline key={item.id || idx} product={item} priceMode='row' />
                                        ))}
                                    </Flex>
                                )}
                            </Collapse>
                        </div>
                    )}

                    {payError && !payError?.missingFields && (
                        <Text mode='sub' className={styles.payError}>
                            {(payError?.message || payError || 'payment_failed_generic')}
                        </Text>
                    )}
                </Flex>

                {/* Sidebar Area (End Side in RTL) */}
                <aside className={styles.sidebar}>
                    <OrderSummary onPayment={handlePayment} paying={paying} showPayBtn={!paymentUrl} missingFields={missingFields} hasNoService={hasNoService} hasElevatorIssue={hasElevatorIssue} hideSummary={isMobile && (paying || paymentUrl)} onWindowExpired={clearWindow} />
                </aside>
            </div>
        </div>
    )
}
