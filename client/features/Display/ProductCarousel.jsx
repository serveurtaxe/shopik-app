import { useEffect } from 'react'
import { Link } from 'react-router'
import HorizontalScroll from '#common/components/HorizontalScroll'
import Flex from '#common/components/Flex'
import Text from '#common/components/Text'
import Icon from '#common/components/Icon'
import { setSalesCache } from '#common/functions/salesCache.js'
import { useText } from '#common/texts/TextProvider'
import ProductCard from 'pages/Products/ProductCard'
import styles from './display.module.css'

export default function ProductCarousel({ block }) {
    const { TR } = useText()
    const { title } = block
    const { showAll, showAllText, autoplaySec } = block.carousel || {}
    const products = block.products || []
    const sales = block.sales || {}
    useEffect(() => { if (Object.keys(sales).length) setSalesCache(sales) }, [sales])
    if (!products.length) return null

    return <Flex col gap={8} className={styles.rail}>
        <Flex className={styles.railHeader} alignItems="center">
            <Text size="h1" bold className={styles.railTitle}>{title || block.name}</Text>
            {showAll !== false && (
                <Link to={`/carousel/${block.id}`} className={styles.showAll}>
                    <Text mode="link" bold size='xl' className={styles.showAllText}>{showAllText || TR('display_show_all_default')}</Text>
                    <Icon name="left" size={24} />
                </Link>
            )}
        </Flex>
        <HorizontalScroll
            autoplaySec={autoplaySec}
            itemClassName={styles.railCard}
            items={products.map(p => (
                <ProductCard
                    key={p.id}
                    product={p}
                    sales={(p.saleIds || []).reduce(
                        (acc, sId) => sales[sId] ? { ...acc, [sId]: sales[sId] } : acc, {})}
                />
            ))}
        />
    </Flex>
}
