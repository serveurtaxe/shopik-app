import { useState, useMemo, useEffect, useRef } from 'react'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Card from 'common/components/Card'
import Collapse from 'common/components/Collapse'
import Loader from 'common/components/Loader'
import render from '#common/functions/render.js'
import styles from './orderSummary.module.css'
import { useUser } from 'features/User'
import { useOrder } from 'features/Order/OrderProvider'
import { useAppData } from 'App'
import WindowOptions from 'features/Order/WindowOptions'
import Addresses, { AddressForm } from 'pages/Account/Addresses'
import { useText } from 'common/texts/TextProvider'
import { CouponCollapse } from './CouponSection'
import { calcShipping, extractShippingConfig } from '#common/functions/shipping.js'
import { fallbackCartTotals } from 'common/functions/cartTotals.js'
import { extractLimits, getMinSumForMethod, getRemainingToMin } from '#common/functions/limits.js'
import Input from 'common/components/Input'
import Form from 'common/components/Form'
import useMediaQuery from 'common/functions/useMediaQuery'
import {
    LuMapPinHouse,
    LuClock,
    LuPencil,
    LuCreditCard,
    LuUserRound
} from 'react-icons/lu'

export default function OrderSummary({ onPayment, paying, showPayBtn = true, missingFields = [], hasNoService = false, hideSummary = false }) {
    const { order = {}, setOrder } = useOrder()
    const user = useUser()
    const { addresses = [] } = user || {}
    const { TR } = useText() || {}

    const [addressOpen, setAddressOpen] = useState(false)
    const [windowOpen, setWindowOpen] = useState(false)
    const [nameOpen, setNameOpen] = useState(false)
    // Mobile: every section starts collapsed
    const isMobile = useMediaQuery('(max-width: 900px)')

    // Refs for focusing missing fields directly 
    const nameFirstRef = useRef(null)
    const emailRef = useRef(null)
    const secondPhoneRef = useRef(null)
    const cityRef = useRef(null)
    const windowRef = useRef(null)

    // A no-service address is not a missing field, but it still needs the
    // address section open so the shopper can edit it.
    useEffect(() => {
        if (hasNoService) setAddressOpen(true)
    }, [hasNoService])

    // Auto-open collapses for missing fields + focus first missing via refs
    useEffect(() => {
        if (!missingFields?.length) return
        const needName = missingFields.includes('name') || missingFields.includes('email') || missingFields.includes('phone') || missingFields.includes('secondPhone')
        const needAddress = missingFields.includes('address')
        const needWindow = missingFields.includes('window')
        if (needName) setNameOpen(true)
        if (needAddress) setAddressOpen(true)
        if (needWindow) setWindowOpen(true)

        const first = missingFields[0]
        const doFocus = () => {
            if (first === 'name' && nameFirstRef.current) {
                nameFirstRef.current.focus()
                try { nameFirstRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' }) } catch { }
                return
            }
            if (first === 'email' && emailRef.current) {
                emailRef.current.focus()
                try { emailRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' }) } catch { }
                return
            }
            if ((first === 'phone' || first === 'secondPhone') && secondPhoneRef.current) {
                secondPhoneRef.current.focus()
                try { secondPhoneRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' }) } catch { }
                return
            }
            if (first === 'address' && cityRef.current) {
                cityRef.current.focus()
                try { cityRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' }) } catch { }
                return
            }
            if (first === 'window' && windowRef.current) {
                try { windowRef.current.scrollIntoView?.({ behavior: 'smooth', block: 'center' }) } catch { }
            }
        }
        // Collapse animation ~300ms, wait a bit longer so input is mounted/visible
        const t = setTimeout(doFocus, 450)
        // retry once in case autocomplete mounts async
        const t2 = setTimeout(doFocus, 900)
        return () => { clearTimeout(t); clearTimeout(t2) }
    }, [missingFields])

    const displayName = (() => {
        const n = order?.name?.first ? order.name : user?.name
        if (n?.first || n?.last) return `${n.first || ''} ${n.last || ''}`.trim()
        return TR?.('full_name')
    })()

    // Get active address from user state or order fallback
    const activeAddress = addresses.find(a => a.active) || addresses[0] || order?.address
    const addressText = activeAddress
        ? `${activeAddress.street} ${activeAddress.building}${activeAddress.apartment ? ` ${TR?.('apartment')} ` + activeAddress.apartment : ''}, ${activeAddress.city}`
        : 'no_address_selected'

    // Get active window from order state
    const activeWindow = order?.window
    const deliveryTimeText = (() => {
        if (!activeWindow?.id) return order.deliveryWindow || TR?.('choose window')
        const dayIdx = activeWindow.dayOfWeek ?? (activeWindow.date ? new Date(activeWindow.date + 'T12:00:00').getDay() : null)
        const dayName = dayIdx != null ? (TR?.(`day-${dayIdx}`) || activeWindow.dayName || '') : (activeWindow.dayName || '')
        const time = `${String(activeWindow.start).padStart(2, '0')}:00-${String(activeWindow.end).padStart(2, '0')}:00`
        return dayName ? `${dayName}, ${time}` : time
    })()

    // Real financial calculations from order
    const { settings } = useAppData() || {}
    const shippingConfig = useMemo(() => extractShippingConfig(settings), [settings])
    const cart = order.cart || []
    const storedTotals = cart.length ? fallbackCartTotals(cart) : null
    const subtotal = order.sum ?? order.subtotal ?? storedTotals?.sum ?? 0
    const shipping = order.shipping ?? calcShipping({ sum: subtotal, deliveryMethod: order.deliveryMethod, shippingConfig })
    const originalShipping = order.deliveryMethod === 'pickup'
        ? Number(shippingConfig?.pickupTotal ?? shippingConfig?.total ?? 0)
        : Number(shippingConfig?.total ?? 0)
    const isFreeShipping = Number(shipping) === 0 && originalShipping > 0 && subtotal > 0
    const deliveryFee = shipping
    const hasCoupon = !!(order?.coupons && order.coupons.length)
    const totalSavings = (() => {
        const before = order.sumNoCoupon ?? order.sum ?? storedTotals?.sumNoCoupon ?? subtotal
        const after = hasCoupon ? (order.finalSum ?? subtotal) : (order.sum ?? subtotal)
        return Math.max(0, Number(before || 0) - Number(after || 0))
    })()
    const total = hasCoupon && order.finalSumWithShipping != null
        ? order.finalSumWithShipping
        : (order.sumWithShipping ?? (subtotal + Number(shipping || 0)))
    const limits = useMemo(() => extractLimits(settings), [settings])
    const minSumThreshold = getMinSumForMethod(limits, order?.deliveryMethod)
    const minSumRemaining = getRemainingToMin({ sum: order?.sum ?? subtotal, deliveryMethod: order?.deliveryMethod, limits })
    const isBelowMinSum = minSumThreshold > 0 && minSumRemaining > 0
    return (
        <Flex col gap={15} className={styles.orderSummaryWrapper}>
            <Text size='xxl' bold className={`${styles.title} ${hideSummary ? styles.hideOnMobile : ''}`}>
                {TR?.('order_summary_title').replace('{orderNumber}', order?.number || '')}
            </Text>

            <Card className={`${styles.summaryCard} ${hideSummary ? styles.hideOnMobile : ''}`}>
                <Flex col>
                    {/* 0. Name Collapse Item */}
                    <Collapse
                        open={nameOpen}
                        onToggle={setNameOpen}
                        showChevron={false}
                        className={styles.summaryCollapse}
                        title={
                            <Flex alignItems='center' justifyContent='space-between' width='100%'>
                                <Flex alignItems='center' gap={12}>
                                    <div className={styles.iconCircle}>
                                        <LuUserRound className={styles.rowIcon} />
                                    </div>
                                    <Text bold size='m' className={styles.rowText}>
                                        {displayName}
                                    </Text>
                                </Flex>
                                <button
                                    type='button'
                                    className={styles.editBtn}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setNameOpen(prev => !prev)
                                    }}
                                    aria-label={TR?.('edit_name')}
                                >
                                    <LuPencil />
                                </button>
                            </Flex>
                        }
                    >
                        <div className={styles.collapseContent}>
                            <NameForm
                                initialName={order?.name?.first ? order.name : user?.name}
                                initialEmail={order?.email || user?.email || ''}
                                initialPhone={order?.phone || user?.phone || ''}
                                initialSecondPhone={order?.secondPhone || user?.secondPhone || ''}
                                missingFields={missingFields}
                                nameFirstRef={nameFirstRef}
                                emailRef={emailRef}
                                secondPhoneRef={secondPhoneRef}
                                onDone={() => setNameOpen(false)}
                            />
                        </div>
                    </Collapse>

                    {/* 1. Address Collapse Item */}
                    <Collapse
                        open={addressOpen}
                        onToggle={setAddressOpen}
                        showChevron={false}
                        className={styles.summaryCollapse}
                        title={
                            <Flex alignItems='center' justifyContent='space-between' width='100%'>
                                <Flex alignItems='center' gap={12}>
                                    <div className={styles.iconCircle}>
                                        <LuMapPinHouse className={styles.rowIcon} />
                                    </div>
                                    <Text bold size='m' className={styles.rowText}>
                                        {addressText}
                                    </Text>
                                </Flex>
                                <button
                                    type='button'
                                    className={styles.editBtn}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setAddressOpen(prev => !prev)
                                    }}
                                    aria-label={TR?.('edit_address')}
                                >
                                    <LuPencil />
                                </button>
                            </Flex>
                        }
                    >
                        <div className={styles.collapseContent}>
                            {addresses.length > 0 ? (
                                <Addresses hideHeader blinkNoService={addressOpen} action={{ onClick: () => setAddressOpen(false) }} />
                            ) : (
                                <AddressForm onDone={() => setAddressOpen(false)} cityRef={cityRef} />
                            )}
                        </div>
                    </Collapse>

                    {/* 2. Delivery Window Collapse Item */}
                    <Collapse
                        open={windowOpen}
                        onToggle={setWindowOpen}
                        showChevron={false}
                        className={styles.summaryCollapse}
                        title={
                            <Flex alignItems='center' justifyContent='space-between' width='100%'>
                                <Flex alignItems='center' gap={12}>
                                    <div className={styles.iconCircle}>
                                        <LuClock className={styles.rowIcon} />
                                    </div>
                                    <Text bold size='m' className={styles.rowText}>
                                        {deliveryTimeText}
                                    </Text>
                                </Flex>
                                <button
                                    type='button'
                                    className={styles.editBtn}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setWindowOpen(prev => !prev)
                                    }}
                                    aria-label={TR?.('edit_delivery_time')}
                                >
                                    <LuPencil />
                                </button>
                            </Flex>
                        }
                    >
                        <div ref={windowRef} className={styles.collapseContent}>
                            {windowOpen && <WindowOptions hideAddress />}
                        </div>
                    </Collapse>

                    {/* 3. Coupon Collapse Item — only shown if user/coupon returns relevant coupons */}
                    <CouponCollapse defaultOpen={!isMobile} />

                    {/* Financial Breakdown */}
                    <Flex col gap={8} className={styles.breakdown}>
                        <Flex alignItems='center' justifyContent='space-between' className={styles.subtotalRow}>
                            <Text mode='sub' size='m'>
                                subtotal_text
                            </Text>
                            <Text size='m' bold>
                                {render({ type: 'coin', value: subtotal })}
                            </Text>
                        </Flex>

                        <Flex alignItems='center' justifyContent='space-between' className={styles.subtotalRow}>
                            <Text mode='sub' size='m'>
                                handling_and_delivery
                            </Text>
                            {isFreeShipping ? (
                                <Flex gap={6} alignItems='center'>
                                    <Text size='m' bold style={{ textDecoration: 'line-through', opacity: 0.6 }}>{render({ type: 'coin', value: originalShipping })}</Text>
                                    <Text size='m' bold>free_shipping</Text>
                                </Flex>
                            ) : (
                                <Text size='m' bold>
                                    {render({ type: 'coin', value: deliveryFee })}
                                </Text>
                            )}
                        </Flex>

                        <Flex alignItems='center' justifyContent='space-between' className={styles.subtotalRow}>
                            <Text size='m' bold className={styles.savingsText}>
                                total_saved_in_purchase
                            </Text>
                            <Text size='m' bold className={styles.savingsText}>
                                {render({ type: 'coin', value: totalSavings })}
                            </Text>
                        </Flex>
                    </Flex>

                    {/* Total + Pay — fixed full-width bottom bar on mobile */}
                    <div className={styles.paySticky}>
                        {/* Total Amount Row */}
                        <Flex alignItems='center' justifyContent='space-between' className={styles.totalRow}>
                            <Text size='xl' bold>
                                total_to_pay
                            </Text>
                            <Text size='xxl' bold className={styles.totalAmount}>
                                {render({ type: 'coin', value: total })}
                            </Text>
                        </Flex>

                        {isBelowMinSum && (
                            <Text size='s' mode='sub' style={{ textAlign: 'center' }}>{TR?.('minimum_order_sum')} {render({ type: 'coin', value: minSumThreshold })}</Text>
                        )}
                        {/* CTA Pay Button */}
                        {showPayBtn && (
                            <button
                                type='button'
                                className={styles.payBtn}
                                onClick={onPayment}
                                disabled={paying || isBelowMinSum}
                            >
                                {paying ? (
                                    <Loader size={16} />
                                ) : (
                                    <>
                                        <LuCreditCard className={styles.payIcon} />
                                        <Text size='l' bold className={styles.payBtnText}>to_payment_btn</Text>
                                    </>
                                )}
                            </button>
                        )}
                    </div>
                </Flex>
            </Card>
        </Flex>
    )
}

function NameForm({ initialName, initialEmail, initialPhone, initialSecondPhone, missingFields = [], nameFirstRef, emailRef, secondPhoneRef, onDone }) {
    const user = useUser()
    const { setOrder } = useOrder()
    const { TR } = useText() || {}
    const [formState, setFormState] = useState({})

    async function handleSubmit(data) {
        setFormState({ loading: true, error: '' })
        try {
            const payload = {}
            // Form deep-expands dotted names (name.first → { name: { first } }),
            // so read the nested shape (flat-key fallback for safety).
            const first = data?.name?.first ?? data['name.first']
            const last = data?.name?.last ?? data['name.last']
            if (first !== undefined || last !== undefined) {
                payload.name = {}
                if (first !== undefined) payload.name.first = String(first).trim()
                if (last !== undefined) payload.name.last = String(last).trim()
            }
            if (data.email !== undefined) payload.email = data.email
            if (data.secondPhone !== undefined && String(data.secondPhone).trim() !== '') payload.secondPhone = String(data.secondPhone).trim()
            const res = await user.userEdit(payload)
            const updatedName = res?.user?.name || { first, last }
            const updatedEmail = res?.user?.email || data.email
            const updatedSecondPhone = res?.user?.secondPhone || data.secondPhone
            setOrder(prev => ({
                ...(prev || {}),
                name: updatedName?.first || updatedName?.last ? updatedName : prev?.name,
                email: updatedEmail || prev?.email,
                secondPhone: updatedSecondPhone || prev?.secondPhone
            }))
            setFormState({ loading: false })
            onDone?.()
        } catch (err) {
            setFormState({ error: err?.message || String(err), loading: false })
            throw err
        }
    }

    return (
        <Form action={handleSubmit} {...formState} submitText={initialName?.first ? 'user_details_update' : 'user_details_save'}>
            <Flex col gap={10}>
                {/* Phone as info only */}
                {initialPhone ? (
                    <Flex gap={6} alignItems='center'>
                        <Text size='s' mode='sub'>{`${TR?.('phone_label')}:`}</Text>
                        <Text size='m' bold>{initialPhone}</Text>
                    </Flex>
                ) : null}
                <Flex gap={10}>
                    <Input ref={nameFirstRef} name='name.first' defaultValue={initialName?.first || ''} required label='name.first' placeholder='name.first' />
                    <Input name='name.last' defaultValue={initialName?.last || ''} required label='name.last' placeholder='name.last' />
                </Flex>
                <Input ref={emailRef} name='email' type='email' defaultValue={initialEmail || ''} required label='email_label' placeholder='email_label' />
                <Input ref={secondPhoneRef} name='secondPhone' type='tel' defaultValue={initialSecondPhone || ''} label='secondPhone' placeholder='secondPhone' />
            </Flex>
        </Form>
    )
}
