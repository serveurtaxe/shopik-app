import Flex from 'common/components/Flex'
import ProductInline from 'common/components/ProductInline'
import ReplacementCard from 'common/components/ReplacementCard'

/**
 * The one place that renders a cart as its entries: a pair card for a replaced
 * product and the line that supplied it, a regular row for everything else. The
 * picking screen, the ops view and the order products list all render through it,
 * so they cannot look different from one another.
 *
 * `entries` comes from groupCart and is rendered in the order given — a screen that
 * groups its own view (the pick tabs) passes its own order. `onItemClick` is only
 * passed by the screens that can work on a product.
 */
export default function CartList({ entries = [], admin = false, onItemClick, className, showLineTotals = false }) {
    const click = line => onItemClick && (() => onItemClick(line))

    return <Flex col gap={10} className={className}>
        {entries.map(entry => entry.type === 'pair'
            ? <ReplacementCard key={entry.key} original={entry.original} replacer={entry.replacer} onClick={click(entry.replacer)} showLineTotals={showLineTotals} />
            : <ProductInline
                key={entry.key}
                product={entry.product}
                remove={false}
                note={false}
                admin={admin}
                showLineTotals={showLineTotals}
                onClick={click(entry.product)}
                style={onItemClick ? { cursor: 'pointer' } : undefined}
            />)}
    </Flex>
}
