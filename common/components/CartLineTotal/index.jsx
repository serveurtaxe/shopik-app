import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import TR from 'common/texts/TR.js'
import { formatPrice } from 'common/components/Product'
import { getLineSummary } from 'common/functions/orderSummary.js'
import styles from './cartLineTotal.module.css'

/**
 * The money of a single cart line as the order holds it: what the line was
 * charged, what it cost before its sale, and the sale that reduced it.
 *
 * It is derived from the line itself (its priceDistribution), so it shows the
 * sale the customer actually got even if the sale no longer exists in the
 * catalog. Screens opt in with `showLineTotals`; the picking and ops screens
 * are about quantities, not money, and stay unchanged.
 */
export default function CartLineTotal({ line }) {
    const summary = getLineSummary(line)
    // A replacement line the picker added has no price until pick_complete runs.
    if (!summary || !summary.priced) return null

    if (summary.notSupplied || !(summary.units > 0)) {
        return <Flex className={styles.notCharged}>
            <Text size='s' mode='sub'>{TR('line_not_charged')}</Text>
        </Flex>
    }

    const saleNames = summary.sales.map(sale => sale.name).filter(Boolean).join(' · ')

    return <Flex col gap={4} className={styles.lineTotal}>
        {summary.saved > 0.005 && <Flex gap={5} alignItems='center' wrap>
            <Icon name='salePercent' size={14} className={styles.saleIcon} />
            <Text size='s' bold className={styles.saleName}>{saleNames || TR('onSale')}</Text>
            <Text size='s' mode='sub'>{TR('sale_saved')} ₪{formatPrice(summary.saved)}</Text>
        </Flex>}
        <Flex gap={8} alignItems='baseline' justifyContent='space-between'>
            <Text size='s' mode='sub'>{TR('line_total')}</Text>
            <Flex gap={6} alignItems='baseline'>
                {summary.saved > 0.005 && <Text size='s' mode='sub' lineThrough>₪{formatPrice(summary.regular)}</Text>}
                <Text size='m' bold>₪{formatPrice(summary.charged)}</Text>
            </Flex>
        </Flex>
    </Flex>
}
