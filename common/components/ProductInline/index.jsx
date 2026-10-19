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
    maxAmount = 0,
    ...props
}) {
    const [noteOpen, setNoteOpen] = useState()
    const isAdmin = admin || variant === 'admin'

    if (isAdmin) {
        const ordered = product.amount ?? 36
        const supplied = product.finalAmount
        const missing = product.missing
        const storageType = product.storageType
        const barcode = product.barcode || ''
        const isCold = storageType === 'cold' || storageType === 'freeze'
        const weight = isWeightProduct(product)
        const orderedLabel = formatAmount(product, ordered)
        const suppliedLabel = supplied != null ? formatAmount(product, supplied) : ''
        let cardStatus = ''
        let pillStatus = ''
        if (missing) {
            cardStatus = styles.red
            pillStatus = styles.red
        } else {
            if (supplied === ordered) {
                cardStatus = styles.green
                pillStatus = styles.green
            } else if (supplied > ordered) {
                cardStatus = styles.red
                pillStatus = styles.red
            } else if (supplied < ordered && supplied != null) {
                cardStatus = styles.yellow
                pillStatus = styles.yellow
            }
        }
        const iconName = icon || (missing ? 'x' : supplied != null ? 'check' : isCold ? 'snow' : 'stock')

        return <Flex tag={Card} gap={10} className={classNames(styles.productInline, styles.admin, cardStatus)} {...props}>
            <ProductImage product={product} size={size} hideSaleBadge />
            <Flex col gap={5} grow={1} justifyContent='space-around'>
                <Icon name={iconName} size={16} className={classNames(styles.remove, styles.iconSlot, pillStatus)} />
                <ProductInfo product={product} sales={sales} size={size} />
                {barcode && <Flex alignItems="center" gap={4} className={styles.barcodeRow}>
                    <Icon name="barcode" size={12} />
                    <Text size="xs" mode="sub">{barcode}</Text>
                </Flex>}
                <Flex wrap alignItems="center" justifyContent="space-between" className={classNames(styles.pill, pillStatus)}>
                    <Text size="s" bold className={styles.pillText}>הוזמן: {orderedLabel}</Text>
                    {missing ? <Text size="s" className={styles.missingText} bold>חסר במלאי</Text>
                        : supplied != null ? <Text size="s" className={classNames(pillStatus, styles.pillText)} bold>סופק: {suppliedLabel}</Text> : null}
                </Flex>
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
                <ProductInfo product={product} sales={sales} size={size} />
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
