import { useText } from 'common/texts/TextProvider'
import render from 'common/functions/render'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import { formatAmount, ProductImage, ProductUnitInfo } from 'common/components/Product'
import { pickStatus } from 'common/components/ProductInline'
import { getLineSummary, isLineNotSupplied, isOrderFinalized } from 'common/functions/orderSummary'
import styles from './orderProductsTable.module.css'

const coin = value => render({ type: 'coin', value })
const EPS = 0.005

// The product cell of a row. A replacement pair shares one row: the original
// is shown struck through on top (it was not supplied) and the product that
// actually came sits under it — the same way the picker sees the pair.
function ProductCell({ entry }) {
    const { TR } = useText()
    const pair = entry.type === 'pair'
    const product = pair ? entry.replacer : entry.product

    return <Flex gap={10} alignItems='center' className={styles.productCell}>
        <ProductImage product={product} size='s' hideSaleBadge className={styles.thumb} />
        <Flex col gap={2} grow={1} className={styles.productInfo}>
            {pair && <Flex gap={6} alignItems='center' wrap>
                <Text size='s' mode='sub' lineThrough ellipsis={1}>{entry.original.name}</Text>
                <Text size='xs' bold className={styles.replaceTag}>{TR('ops_replaced')}</Text>
            </Flex>}
            <Text size='m' bold ellipsis={2} title={product.name}>{product.name}</Text>
            <Text size='s' mode='sub'><ProductUnitInfo product={product} /></Text>
            {product.barcode && <Flex gap={4} alignItems='center'>
                <Text size='s' mode='sub'><bdi>{product.barcode}</bdi></Text>
                <Icon name='barcode' size={12} />
            </Flex>}
        </Flex>
    </Flex>
}

function SuppliedCell({ line, finalized }) {
    const { TR } = useText()
    if (finalized && isLineNotSupplied(line)) {
        return <Text size='s' bold className={styles.missing}>{TR('not_supplied')}</Text>
    }
    if (finalized && line?.finalAmount != null) {
        return <Text size='m' bold className={styles[pickStatus(line)]}>{formatAmount(line, line.finalAmount)}</Text>
    }
    // Not picked yet: the ordered amount is still what the customer is paying for.
    return <Text size='m' mode='sub'>{formatAmount(line, line?.amount)}</Text>
}

// The unit price as the site shows it: when the whole line sits on one sale,
// the sale's own unit price is the big number and the regular one is struck
// through under it. A line split between a sale and regular units shows the
// regular price and the sale badge only — a blended unit price would be wrong.
function PriceCell({ line }) {
    const { TR } = useText()
    const sale = line?.sales?.length === 1 && Math.abs(line.sales[0].amount - line.units) < EPS
        ? line.sales[0]
        : null
    const saleUnit = sale?.perUnit > 0 ? sale.perUnit : 0
    const saleNames = line?.saved > EPS
        ? line.sales.map(item => item.name).filter(Boolean).join(' · ') || TR('onSale')
        : ''

    return <Flex col gap={3}>
        {saleUnit
            ? <>
                <Text size='m' bold className={styles.salePrice}>{coin(saleUnit)}</Text>
                <Text size='s' mode='sub' lineThrough>{coin(line.unitPrice)}</Text>
            </>
            : <Text size='m'>{line?.priced ? coin(line.unitPrice) : TR('not_priced_yet')}</Text>}
        {saleNames && <Flex gap={4} alignItems='center' className={styles.saleTag}>
            <Icon name='salePercent' size={13} />
            <Text size='s' bold>{saleNames}</Text>
        </Flex>}
    </Flex>
}

/**
 * The order's products as a table. One row per entry (a replacement pair is one
 * row) and the columns follow the money: ordered, supplied, the unit price with
 * the sale the line got, the pre-sale total, the saving and what was charged.
 *
 * All money comes from the line itself through getLineSummary, so the footer
 * reconciles with the payment card above instead of re-deriving anything.
 */
export default function OrderProductsTable({ order, entries = [], summary }) {
    const finalized = isOrderFinalized(order)
    const lines = entries.flatMap(entry => entry.type === 'pair'
        ? [entry.original, entry.replacer]
        : [entry.product])
    const showRefunded = Number(summary?.refundedTotal) > 0
        || lines.some(line => Number(line?.refundedAmount) > 0)
    // The order's own total is authoritative (it also covers general and
    // shipping refunds that are not attached to a line); the rows show the part
    // allocated to each product.
    const refundedSum = Number(summary?.refundedTotal) > 0
        ? Number(summary.refundedTotal)
        : lines.reduce((sum, line) => sum + (Number(line?.refundedAmount) || 0), 0)

    return <div className={styles.tableWrap}>
        <table className={styles.table}>
            <thead>
                <tr>
                    <th><Text size='s' bold>{'col_product'}</Text></th>
                    <th className={styles.num}><Text size='s' bold>{'col_ordered'}</Text></th>
                    <th className={styles.num}><Text size='s' bold>{'col_supplied'}</Text></th>
                    <th><Text size='s' bold>{'col_price_sale'}</Text></th>
                    <th className={styles.num}><Text size='s' bold>{'col_before_sales'}</Text></th>
                    <th className={styles.num}><Text size='s' bold>{'col_saved'}</Text></th>
                    <th className={styles.num}><Text size='s' bold>{'col_line_total'}</Text></th>
                    {showRefunded && <th className={styles.num}><Text size='s' bold>{'col_refunded'}</Text></th>}
                </tr>
            </thead>
            <tbody>
                {entries.map(entry => {
                    const pair = entry.type === 'pair'
                    const product = pair ? entry.replacer : entry.product
                    const orderedLine = pair ? entry.original : entry.product
                    const line = getLineSummary(product, { finalized })
                    const refunded = (Number(orderedLine?.refundedAmount) || 0) + (Number(product?.refundedAmount) || 0)

                    return <tr key={entry.key}>
                        <td><ProductCell entry={entry} /></td>
                        <td className={styles.num}>{formatAmount(orderedLine, orderedLine.amount)}</td>
                        <td className={styles.num}><SuppliedCell line={product} finalized={finalized} /></td>
                        <td><PriceCell line={line} /></td>
                        <td className={styles.num}>
                            {line?.regular > 0
                                ? <Text size='m'>{coin(line.regular)}</Text>
                                : '—'}
                        </td>
                        <td className={styles.num}>
                            {line?.saved > EPS
                                ? <Text size='s' bold className={styles.saved}>{`-${coin(line.saved)}`}</Text>
                                : '—'}
                        </td>
                        <td className={styles.num}>
                            {line?.supplied
                                ? <Text size='m' bold className={line.saved > EPS ? styles.totalDiscounted : styles.total}>{coin(line.charged)}</Text>
                                : '—'}
                        </td>
                        {showRefunded && <td className={styles.num}>
                            {refunded > 0
                                ? <Text size='s' bold className={styles.refunded}>{coin(refunded)}</Text>
                                : '—'}
                        </td>}
                    </tr>
                })}
            </tbody>
            <tfoot>
                <tr>
                    <td colSpan={4}><Text size='m' bold>{'table_total'}</Text></td>
                    <td className={styles.num}><Text size='m' bold>{coin(summary.productsBeforeSales)}</Text></td>
                    <td className={styles.num}>
                        {summary.saleSavings > EPS
                            ? <Text size='m' bold className={styles.saved}>{`-${coin(summary.saleSavings)}`}</Text>
                            : '—'}
                    </td>
                    <td className={styles.num}><Text size='m' bold>{coin(summary.productsAfterSales)}</Text></td>
                    {showRefunded && <td className={styles.num}>
                        <Text size='m' bold className={styles.refunded}>{refundedSum > 0 ? coin(refundedSum) : '—'}</Text>
                    </td>}
                </tr>
            </tfoot>
        </table>
    </div>
}
