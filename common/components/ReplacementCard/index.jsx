import classNames from 'common/functions/classNames'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import TR from 'common/texts/TR.js'
import { PickPill, pickStatus } from 'common/components/ProductInline'
import CartLineTotal from 'common/components/CartLineTotal'
import { formatPrice, ProductImage, ProductPrice, ProductUnitInfo } from 'common/components/Product'
import styles from './replacementCard.module.css'

/**
 * A replaced product and the product that supplied its order, as one linked card:
 * the original the customer ordered on top, the divider that runs across the whole
 * card in the state colour, then what was actually supplied.
 *
 * Every cart screen renders a pair through this — the picking screen, the ops view
 * and the order products list — so they cannot disagree about the same cart.
 * `onClick` is optional: only the screens that can work on a product pass it.
 */
export default function ReplacementCard({ original = {}, replacer = {}, onClick, showLineTotals = false }) {
    const status = pickStatus(replacer)

    // Same sizes as a regular pick row (name 14px, unit info and barcode 12px),
    // same ordered/supplied pill, which belongs to the product that filled the order.
    return <Flex col onClick={onClick} style={{ cursor: onClick ? 'pointer' : undefined }} className={classNames(styles.replacedCard, styles[status])}>
        <Flex col gap={6} className={styles.replacedOriginal}>
            <Text size="m" bold>
                {original.name || TR('ops_product_name_fallback')}{original.price != null ? ` - ₪${formatPrice(original.price)}` : ''}
            </Text>
            {showLineTotals && <CartLineTotal line={original} />}
            {original.barcode && <Flex alignItems="center" gap={4} justifyContent="end">
                <Text size="s" mode="sub">{original.barcode}</Text>
                <Icon name="barcode" size={12} />
            </Flex>}
        </Flex>
        <Flex gap={10} className={styles.replacedReplacement}>
            <ProductImage product={replacer} size="s" hideSaleBadge />
            <Flex col gap={5} grow={1} justifyContent='space-around'>
                <ProductPrice product={replacer} size="s" />
                <Text size="s" mode="sub"><ProductUnitInfo product={replacer} /></Text>
                <Text size="m" bold className={styles.replacedName}>{replacer.name || TR('ops_product_name_fallback')}</Text>
                {replacer.barcode && <Flex alignItems="center" gap={4} justifyContent="end" className={styles.replacedBarcode}>
                    <Text size="s" mode="sub">{replacer.barcode}</Text>
                    <Icon name="barcode" size={12} />
                </Flex>}
                <PickPill product={replacer} status={status} />
                {showLineTotals && <CartLineTotal line={replacer} />}
            </Flex>
        </Flex>
    </Flex>
}
