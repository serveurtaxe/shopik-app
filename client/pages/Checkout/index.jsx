import { useState, useEffect } from 'react'
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
import { extractLimits, getMinSumForMethod, getRemainingToMin } from '#common/functions/limits.js'
import useMediaQuery from 'common/functions/useMediaQuery'
import render from '#common/functions/render.js'

export default function Checkout() {
    const { order = {}, setOrder } = useOrder()
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
        else if (order.window.leadTimestamp && new Date(order.window.leadTimestamp).getTime() < Date.now()) missing.push('window')
        return missing
    }
    useEffect(() => {
        if (!user?.id) navigate('/')
        else if (!order?.cart || !order.cart.length) navigate('/')
    }, [user, order?.cart])
    // If window lead time has passed, clear it from the order and prompt user to pick a new one
    useEffect(() => {
        if (!order?.window?.leadTimestamp) return
        const ts = new Date(order.window.leadTimestamp).getTime()
        if (Number.isNaN(ts) || ts >= Date.now()) return
        // expired → remove window from local order state and show missing
        setOrder(prev => {
            if (!prev?.window) return prev
            const { window: _w, ...rest } = prev
            return rest
        })
        setMissingFields(prev => (prev.includes('window') ? prev : [...prev, 'window']))
    }, [order?.window?.leadTimestamp, order?.window?.id])

    // Listen for hyp callback postMessage (lightweight loader html) + fetch updated order
    const iframeRef = useRef(null)
    useEffect(() => {
        function onMessage(e) {
            const allowedOrigins = [window.location.origin, 'https://shopik.co.il']
            if (!allowedOrigins.includes(e.origin)) return
            const data = e.data || {}
            if (data.type !== 'hyp_callback') return
            if (data.ok && data.orderNumber) {
                // verify via API then show success
                apiReq('order/status', { orderNumber: data.orderNumber }).then(res => {
                    const paidOrder = res?.order || res?.data || order
                    if (paidOrder?.status === 'paid' || data.ok) {
                        setDoneOrder(paidOrder?.id ? paidOrder : { ...order, number: data.orderNumber })
                        setPaymentUrl(null)
                    }
                }).catch(() => {
                    setDoneOrder({ ...order, number: data.orderNumber })
                    setPaymentUrl(null)
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
            // fallback if postMessage missed - check query for Order/CCode
            if (href.includes('hyp/callback') || href.includes('success') || search.includes('CCode=')) {
                const params = new URLSearchParams(search)
                const orderNumber = params.get('Order') || params.get('order')
                const ccode = params.get('CCode') ?? params.get('Ccode')
                const isOk = ccode === '0' || ccode === '700'
                if (isOk && orderNumber) {
                    setDoneOrder(prev => prev || { ...order, number: orderNumber })
                    setPaymentUrl(null)
                }
            }
        } catch { }
    }

    async function handlePayment() {
        if (paying) return
        if (isBelowMinSum) {
            const label = TR?.('minimum_order_sum')
            setPayError({ message: `${label} ${minSumThreshold}` })
            return
        }
        // Client-side pre-validation: if we already know fields are missing, open them and don't hit server
        const localMissing = getLocalMissing()
        if (localMissing.length) {
            setMissingFields(localMissing)
            if (localMissing.includes('window') && order?.window?.leadTimestamp && new Date(order.window.leadTimestamp).getTime() < Date.now()) {
                setOrder(prev => {
                    if (!prev?.window) return prev
                    const { window: _w, ...rest } = prev
                    return rest
                })
            }
            return
        }
        setPaying(true)
        setPayError()
        setMissingFields([])
        try {
            const res = await apiReq('payment/create', { orderId: order.id })
            if (res?.paymentUrl) setPaymentUrl(res.paymentUrl)
        } catch (e) {
            console.error('payment create failed:', e)
            setPayError(e)
            const fields = e?.missingFields || e?.data?.missingFields || []
            if (Array.isArray(fields) && fields.length) {
                // trigger auto-open one-by-one (OrderSummary watches this array)
                setMissingFields(fields)
                if (fields.includes('window')) {
                    setOrder(prev => {
                        if (!prev?.window) return prev
                        const { window: _w, ...rest } = prev
                        return rest
                    })
                }
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
                                            <ProductInline key={item.id || idx} product={item} />
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
                    <OrderSummary onPayment={handlePayment} paying={paying} showPayBtn={!paymentUrl} missingFields={missingFields} hideSummary={isMobile && (paying || paymentUrl)} />
                </aside>
            </div>
        </div>
    )
}
