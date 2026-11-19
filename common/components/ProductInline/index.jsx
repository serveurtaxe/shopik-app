import { ProductButton, ProductImage, ProductInfo, ProductStamps, formatAmount, getUnitLabel, isWeightProduct, getFirstSale, getInlineSaleBarText } from 'common/components/Product'
import classNames from 'common/functions/classNames'
import styles from './productInline.module.css'
import Button from 'common/components/Button'
import Card from 'common/components/Card'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import { useState } from 'react'
import { getProductState } from '#common/functions/productState.js'
import CartLineTotal from 'common/components/CartLineTotal'

// Pick state of an admin product row: what was ordered against what was supplied.
// Empty until the final amount is entered. Plain keys so each component can resolve
// them in its own stylesheet.
export function pickStatus(product = {}) {
    if (product.missing) return 'red'
    const supplied = product.finalAmount
    if (supplied == null) return ''
    const ordered = product.amount ?? 36
    if (supplied === ordered) return 'green'
    return supplied > ordered ? 'red' : 'yellow'
}

function pickIcon(product = {}) {
    if (product.missing) return 'x'
    if (product.finalAmount != null) return 'check'
    return product.storageType === 'cold' || product.storageType === 'freeze' ? 'snow' : 'stock'
}

// The ordered/supplied pill of an admin pick row.
export function PickPill({ product = {}, status = pickStatus(product) }) {
    const supplied = product.finalAmount
    return <Flex wrap alignItems="center" justifyContent="space-between" className={classNames(styles.pill, styles[status])}>
        <Text size="s" bold className={styles.pillText}>הוזמן: {formatAmount(product, product.amount ?? 36)}</Text>
        {product.missing
            ? <Text size="s" bold className={classNames(styles[status], styles.missingText)}>חסר במלאי</Text>
            : supplied != null
                ? <Text size="s" bold className={classNames(styles[status], styles.pillText)}>סופק: {formatAmount(product, supplied)}</Text>
                : null}
    </Flex>
}

export default function ProductInline({
    product,
    remove = true,
    note = true,
    onRemove,
    onUpdateAmount,
    amount,
    sales,
    size = 's',
    admin = false,
    variant,
    icon,
    saleTotalAmount,
    priceMode = 'unit',
    showLineTotals = false,
    maxAmount = 0,
    ...props
}) {
    const [noteOpen, setNoteOpen] = useState()
    const isAdmin = admin || variant === 'admin'

    if (isAdmin) {
        const status = pickStatus(product)
        const barcode = product.barcode || ''

        return <Flex tag={Card} gap={10} className={classNames(styles.productInline, styles.admin, styles[status])} {...props}>
            <ProductImage product={product} size={size} hideSaleBadge />
            <Flex col gap={5} grow={1} justifyContent='space-around'>
                <Icon name={icon || pickIcon(product)} size={16} className={classNames(styles.remove, styles.iconSlot, styles[status])} />
                <ProductInfo product={product} sales={sales} size={size} priceMode={priceMode} saleTotalAmount={saleTotalAmount} />
                {barcode && <Flex alignItems="center" gap={4} justifyContent="end" className={styles.barcodeRow}>
                    <Text size="s" mode="sub">{barcode}</Text>
                    <Icon name="barcode" size={12} />
                </Flex>}
                <PickPill product={product} status={status} />
                {showLineTotals && <CartLineTotal line={product} />}
                {product.picking?.recommendations && <Flex alignItems="center" gap={6} className={styles.noteRow}>
                    <Icon name="note" size={12} />
                    <Text size="xs">{product.picking.recommendations}</Text>
                </Flex>}
            </Flex>
        </Flex>
    }

    const sale = getFirstSale(product, sales)
    const showSaleBar = !!sale && !isAdmin
    const saleAmountForBar = saleTotalAmount != null ? saleTotalAmount : (amount ?? product?.amount ?? 0)
    const saleBarText = showSaleBar ? getInlineSaleBarText(sale, saleAmountForBar) : null

    // Same two axes as the product card — getProductState is shared so the
    // cart row and the listing card can never disagree about a product's
    // state. Colours resolve in common/components/Product/product.module.css.
    const { action, price } = getProductState({ amount, sale })

    return <Card
        className={classNames(styles.productInline, styles.cardWithSaleBar)}
        data-action={action}
        data-price={price}
        {...props}>
        <Flex gap={10} className={styles.productInlineMain}>
            <ProductImage product={product} size={size} hideSaleBadge />
            <Flex col gap={5} justifyContent='space-around' grow={1}>
                {remove && onRemove && <Button icon='trash' mode='text' stopPropagation preventDefault onClick={onRemove} className={styles.remove} />}
                <ProductInfo product={product} sales={sales} size={size} priceMode={priceMode} saleTotalAmount={saleTotalAmount} />
                <ProductStamps product={product} />
                <Flex alignItems='center' justifyContent='space-between'>
                    {note && <Button
                        onClick={() => setNoteOpen(n => !n)}
                        icon='note' mode='text' stopPropagation preventDefault
                        className={classNames(styles.note, [styles.active, noteOpen])} />}
                    {(onUpdateAmount != null || amount != null) && <ProductButton product={product} amount={amount} onUpdateAmount={onUpdateAmount} size={size} sales={sales} maxAmount={maxAmount} />}
                </Flex>
            </Flex>
        </Flex>
        {showSaleBar && saleBarText && (
            <Flex alignItems="center" justifyContent="center" gap={6} className={styles.saleInlineBar}>
                <Icon name="salePercent" size={18} className={styles.saleInlineBarIcon} />
                <Text size="m" bold className={styles.saleInlineBarText}>{saleBarText}</Text>
            </Flex>
        )}
    </Card>
}
