import { useState, useMemo } from 'react'
import Button from 'common/components/Button'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import { useText } from 'common/texts/TextProvider'
import classNames from 'common/functions/classNames'
import { useCart } from './CartProvider'
import { closeAllPopovers } from 'common/components/Popover/registry'
import events from 'common/features/events'
import { useOrder } from 'features/Order/OrderProvider'
import { useAppData } from 'App'
import { getRemainingToFreeShipping, extractShippingConfig } from '#common/functions/shipping.js'
import styles from './cart.module.css'

export default function MiniCart({
    isOpen: controlledIsOpen,
    onToggle,
    freeShippingThreshold,
    className
}) {
    const [internalIsOpen, setInternalIsOpen] = useState(false)
    const { cartOpen: ctxCartOpen, toggleCart: ctxToggleCart } = useCart?.() || {}


    const isOpen = controlledIsOpen !== undefined
        ? controlledIsOpen
        : (ctxCartOpen !== undefined ? ctxCartOpen : internalIsOpen)
    const { TR } = useText?.() || {}
    const { order } = useOrder()
    const { settings } = useAppData() || {}
    const shippingConfig = useMemo(() => extractShippingConfig(settings), [settings])
    // sum pre-coupon per spec; if coupon present, show discounted total
    const sum = order?.sum ?? 0
    const hasCoupon = !!(order?.coupons && order.coupons.length)
    const sumWithShipping = order?.sumWithShipping ?? (order?.shipping != null ? (sum + Number(order.shipping || 0)) : sum)
    const total = hasCoupon && order?.finalSumWithShipping != null ? order.finalSumWithShipping : sumWithShipping
    const itemCount = order?.cart?.length

    const handleToggle = (e) => {
        // Cart and popovers never share the screen: opening/closing the cart
        // dismisses login, delivery, info and any other open popover.
        closeAllPopovers()
        // Menus are Header-owned: let Header close drawer + product menu.
        events.emit('cart-toggled')
        if (onToggle) {
            onToggle(e)
        } else if (controlledIsOpen === undefined) {
            if (ctxToggleCart) {
                ctxToggleCart()
            } else {
                setInternalIsOpen((prev) => !prev)
            }
        }
    }

    const isCartEmpty = !itemCount || itemCount === 0
    const formattedTotal = Number(total || 0).toLocaleString('he-IL', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1
    })

    const effectiveThreshold = freeShippingThreshold ?? (order?.deliveryMethod === 'pickup'
        ? (shippingConfig?.pickupFreeFrom ?? shippingConfig?.freeFrom)
        : (shippingConfig?.freeFrom))
    const remaining = effectiveThreshold != null
        ? getRemainingToFreeShipping({ sum, deliveryMethod: order?.deliveryMethod, shippingConfig })
        : Math.round(Math.max(0, (freeShippingThreshold ?? 0) - sum))

    // DRY Translations from hebrew.json
    const toPayText = TR?.('to_pay')
    const currencySymbol = TR?.('currency_symbol')
    const subtext = isCartEmpty
        ? (TR?.('cart_empty_subtext')) :
        remaining ?
            (TR?.('free_shipping_subtext')).replace('{remaining}', remaining) : TR?.('free_shipping')

    // Shared Cart Icon with Badge element
    const cartIconElement = (
        <div className={styles.cartIconWrapper}>
            <Icon
                name="cart"
                className={classNames(styles.cartIcon, [styles.cartIconOpen, isOpen])}
            />
            {!isCartEmpty && <span className={styles.badge}>{itemCount}</span>}
        </div>
    )

    return (
        <Button
            className={classNames(styles.miniCartButton, className)}
            onClick={handleToggle}
            aria-label={TR?.('aria_mini_cart')}
        >
            {/* Cart Icon + Badge */}
            <div className={styles.cartIconSlot}>
                {cartIconElement}
            </div>

            {/* Desktop View Text Content */}
            <Flex col className={styles.desktopContent} gap={2} alignItems="start">
                <Text size='s' className={styles.mainText}>
                    {toPayText} {formattedTotal} {currencySymbol}
                </Text>
                <Text size='xs' className={styles.subText}>
                    {subtext}
                </Text>
            </Flex>

            {/* Tablet & Mobile Price Label */}
            <Text className={styles.compactPrice}>
                {formattedTotal} {currencySymbol}
            </Text>

            {/* Chevron Arrow */}
            <Icon
                name="down"
                className={classNames(styles.chevronIcon, [styles.chevronOpen, isOpen])}
            />
        </Button>
    )
}