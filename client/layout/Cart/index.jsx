import { useOrder } from 'features/Order/OrderProvider'
import { useCart } from './CartProvider'
import Button from 'common/components/Button'
import Icon from 'common/components/Icon'
import Text from 'common/components/Text'
import Flex from 'common/components/Flex'
import classNames from 'common/functions/classNames'
import styles from './cart.module.css'
import ProductInline from './ProductInline'
import ConfirmButton from 'common/components/ConfirmButton'
import render from 'common/functions/render.js'
import apiReq from 'common/functions/apiReq.js'
import { useNavigate } from 'react-router'
import { useMemo, useEffect } from 'react'
import useMediaQuery from 'common/functions/useMediaQuery'
import { markCartLoginPending } from './cartLoginPending'
import { useAppData } from 'App'
import { calcShipping, extractShippingConfig } from '#common/functions/shipping.js'
import { fallbackCartTotals } from 'common/functions/cartTotals.js'
import { extractLimits, getMinSumForMethod, getRemainingToMin } from '#common/functions/limits.js'
import { useText } from 'common/texts/TextProvider'
import events from 'common/features/events.js'
import { useUser } from 'features/User'

export default function Cart({ }) {
    const
        { order = {}, setOrder } = useOrder(),
        user = useUser(),
        cart = order?.cart || [],
        emptyCart = !cart.length,
        navigate = useNavigate()

    const { cartOpen, setCartOpen } = useCart()
    // Mobile login lives in the menu drawer, not in a popover
    const isMobile = useMediaQuery('(max-width: 768px)')
    const { settings } = useAppData() || {}
    const { TR } = useText() || {}
    const shippingConfig = useMemo(() => extractShippingConfig(settings), [settings])
    const limits = useMemo(() => extractLimits(settings), [settings])

    const sum = order?.sum ?? (cart.length ? fallbackCartTotals(cart).sum : 0)
    // threshold uses post-sale pre-coupon total (sumBeforeCoupon == sum)
    const minSumThreshold = getMinSumForMethod(limits, order?.deliveryMethod)
    const minSumRemaining = getRemainingToMin({ sum, deliveryMethod: order?.deliveryMethod, limits })
    const isBelowMinSum = minSumThreshold > 0 && minSumRemaining > 0
    const shipping = order?.shipping ?? calcShipping({ sum, deliveryMethod: order?.deliveryMethod, shippingConfig })
    const sumWithShipping = order?.sumWithShipping ?? (sum + Number(shipping || 0))
    const finalSumWithShipping = order?.finalSumWithShipping
    const hasCoupon = !!(order?.coupons && order.coupons.length)
    const displayTotal = hasCoupon && finalSumWithShipping != null ? finalSumWithShipping : sumWithShipping
    const originalShipping = order?.deliveryMethod === 'pickup'
        ? Number(shippingConfig?.pickupTotal ?? shippingConfig?.total ?? 0)
        : Number(shippingConfig?.total ?? 0)
    const isFreeShipping = Number(shipping) === 0 && originalShipping > 0 && sum > 0
    const savings = (() => {
        const fallback = cart.length ? fallbackCartTotals(cart) : null
        const before = order?.sumNoCoupon ?? order?.sum ?? fallback?.sumNoCoupon ?? 0
        // include coupon discount in savings when coupon present
        const after = hasCoupon ? (order?.finalSum ?? sum) : sum
        return Math.max(0, before - after)
    })()

    function goToCheckout() {
        if (isBelowMinSum) return
        if (!user?.id) {
            if (isMobile) {
                markCartLoginPending()
                setCartOpen(false)
                events.emit('mobile-login')
            } else {
                events.emit('login-popover')
            }
        } else if (!emptyCart) {
            navigate('/checkout')
            setCartOpen(false)
        }
    }

    // After a mobile menu login that started from cart pay, reopen the cart
    useEffect(() => {
        const reopen = () => setCartOpen(true)
        events.on('reopen-cart', reopen)
        return () => events.off('reopen-cart', reopen)
    }, [setCartOpen])

    function clearCart() {
        if (emptyCart) return
        setOrder({
            ...order,
            cart: [],
            sales: {},
            sum: 0,
            sumNoCoupon: 0,
            finalSum: 0,
            finalSumNoCoupon: 0,
            shipping: 0,
            sumWithShipping: 0,
            finalShipping: 0,
            finalSumWithShipping: 0
        })
        apiReq('order/cart/clear', {})
            .then(({ order: serverOrder }) => {
                if (serverOrder) setOrder(serverOrder)
            })
            .catch(() => { })
    }

    return <Flex col className={classNames(styles.cart, [styles.open, cartOpen])}>
        <Flex className={styles.header} alignItems='center' justifyContent='space-between'>
            <Text size='xxl' bold>cart_title</Text>
            <Flex className={styles.actions} center gap={15}>
                {/* <Button icon='coupon' mode='vertical'>coupons</Button>
                <Button icon='listPlus' mode='vertical'>save_list</Button> */}
                <ConfirmButton
                    icon='trash' mode='vertical'
                    disabled={emptyCart}
                    q='clear_cart_confirm'
                    onOk={clearCart}>
                    clear_cart
                </ConfirmButton>
            </Flex>
        </Flex>

        {emptyCart ?
            <Flex col gap={10} className={styles.emptyCart} center>
                <Text size='xxl' bold>empty_cart_title</Text>
                <Text >empty_cart_subtitle</Text>
                <Icon name='heartPlus' />
            </Flex>
            :
            <Flex col gap={10} className={styles.items} >
                {cart.map(item => <ProductInline key={item.id} product={item} />)}
            </Flex>
        }

        <Flex col className={styles.footer}>
            <Flex col gap={15} className={styles.summary}>
                <Flex alignItems='center' justifyContent='space-between'>
                    <Text bold>subtotal_text</Text>
                    <Text bold>{render({ type: 'coin', value: sum })}</Text>
                </Flex>
                <Flex alignItems='center' justifyContent='space-between'>
                    <Text bold>handling_and_delivery</Text>
                    {isFreeShipping ? (
                        <Flex gap={6} alignItems='center'>
                            <Text bold style={{ textDecoration: 'line-through', opacity: 0.6 }}>{render({ type: 'coin', value: originalShipping })}</Text>
                            <Text bold>free_shipping</Text>
                        </Flex>
                    ) : (
                        <Text bold>{render({ type: 'coin', value: shipping })}</Text>
                    )}
                </Flex>
                <Flex alignItems='center' justifyContent='space-between' className={styles.totalSaved}>
                    <Text size='l' bold>total_saved_in_purchase</Text>
                    <Text size='l' bold>{render({ type: 'coin', value: savings })}</Text>
                </Flex>
            </Flex>
            {isBelowMinSum && !emptyCart && (
                <Text size='s' className={styles.minSumNote}>{TR?.('minimum_order_sum')} {render({ type: 'coin', value: minSumThreshold })}</Text>
            )}
            <Button icon='cart' onClick={goToCheckout} disabled={isBelowMinSum}>
                <Text>to_pay</Text>
                <Text>{render({ type: 'coin', value: displayTotal })}</Text>
            </Button>
        </Flex>
    </Flex >
}
