import styles from './productCard.module.css'
import Flex from 'common/components/Flex'
import { Link } from 'react-router'
import {
    ProductImage,
    ProductInfo,
    ProductPrice,
    ProductButton as CommonProductButton,
    ProductFavorite,
    ProductStamps,
    getFirstSale,
    getUnitPriceText
} from 'common/components/Product'
import { useProductCart } from 'common/components/Product/useProductCart.js'
import { getProductState } from '#common/functions/productState.js'

// Re-export common presentational helpers for backward compatibility
export { ProductImage, ProductInfo, ProductPrice, getUnitPriceText }

export default function ProductCard(props) {
    const { product, sales = {}, size = 'm' } = props
    const { amount, updateAmount, productMaxAmount } = useProductCart(product, sales)
    const { action, price } = getProductState({ amount, sale: getFirstSale(product, sales) })

    return <Flex
        tag={Link}
        to={`/product/${product.id}`}
        state={{ product }}
        col gap={10} justifyContent='space-between'
        data-action={action}
        data-price={price}
        className={styles.productCard}>
        <ProductFavorite />
        <ProductImage {...props} />
        <ProductInfo {...props} />
        <ProductStamps product={product} className={styles.stamps} />
        <CommonProductButton
            product={product}
            sales={sales}
            size={size}
            amount={amount}
            onUpdateAmount={updateAmount}
            maxAmount={productMaxAmount}
        />
    </Flex>
}

// Standalone cart-wired button for consumers outside the card shell
// (e.g. the related-products rail on the product page).
export function ProductButton({ product, sales = {} }) {
    const { amount, updateAmount, productMaxAmount } = useProductCart(product, sales)
    return <CommonProductButton product={product} sales={sales} amount={amount} onUpdateAmount={updateAmount} maxAmount={productMaxAmount} />
}