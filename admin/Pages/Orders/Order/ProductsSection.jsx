import { useState } from 'react'
import Card from 'common/components/Card'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Tabs from 'common/components/Tabs'
import CartList from 'common/components/CartList'
import { groupCart } from 'common/functions/cartReplacements'
import { getOrderSummary } from 'common/functions/orderSummary'
import OrderProductsTable from './OrderProductsTable'
import styles from './order.module.css'

const VIEWS = [
    { value: 'table', text: 'view_table', icon: 'table' },
    { value: 'cards', text: 'view_cards', icon: 'grid' }
]

/**
 * The products of an order. The table is the default: it lines the money up
 * column by column (ordered, supplied, price/sale, saving, total) and stays
 * readable on orders with dozens of lines, where cards become a long scroll.
 * The cards view is the picker-style list, kept behind a toggle.
 */
export default function ProductsSection({ order }) {
    const [view, setView] = useState('table')
    const entries = groupCart(order.cart || [])
    const summary = getOrderSummary(order)

    return <Card className={styles.productsCard}>
        <Flex gap={8} alignItems='center' className={styles.productsCardHeader}>
            <Text size='h3' bold className={styles.productsCardTitle}>{'products_in_order'}</Text>
            {/* A pair counts once: the customer ordered one product, and the line
              that supplied it is not a second one they ordered. */}
            <Text size='s' bold className={styles.countPill}>{entries.length}</Text>
            <Tabs
                options={VIEWS}
                active={view}
                onChange={setView}
                className={styles.viewToggle}
                style={{ width: 'auto', minWidth: 0 }}
            />
        </Flex>
        {view === 'table'
            ? <OrderProductsTable order={order} entries={entries} summary={summary} />
            : <CartList entries={entries} admin showLineTotals />}
    </Card>
}
