import styles from './product.module.css'
import Button from 'common/components/Button'
import Image from 'common/components/Image'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import classNames from 'common/functions/classNames'
import KashrutStamps from 'common/components/Kashrut'
import { DietIcons } from 'common/components/Nutrition'
import { round2, round3 } from 'common/functions/calcOrder/utils.js'
import { getProductImageUrl, mainImageHash } from 'common/functions/productImageUrl.js'
import { getRowPriceInfo, isBundleReached } from 'common/functions/rowPrice.js'
import { getUnitPriceText, parseWeightOrVolume } from 'common/functions/unitPrice.js'
import { getFirstSale, getSalePriceInfo } from 'common/functions/salePrice.js'
import { useState, useEffect } from 'react'
import TR from 'common/texts/TR.js'

// Re-exported for existing callers; the implementation lives in
// common/functions/salePrice.js so the server feed can share it.
export { getFirstSale, getSalePriceInfo }

export function getSaleBadgeText(sale) {
    if (!sale) return null
    const amount = sale.amount
    const price = sale.price
    const percent = sale.percent
    if (sale.kind === 'price' && amount > 1 && price != null) return `מבצע ${amount} ב-${price}`
    if (sale.kind === 'price' && price != null) return `מבצע ב-${price}`
    if (sale.kind === 'percent' && percent != null) return `${percent}% הנחה`
    if (amount > 1 && price != null) return `מבצע ${amount} ב-${price}`
    if (percent != null) return `מבצע ${percent}%`
    return 'מבצע'
}

export function formatPrice(price) {
    if (price == null || isNaN(price)) return ''
    const n = Number(price)
    return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, '')
}

export function getSaleRemaining(sale, amount) {
    if (!sale || !sale.amount || sale.amount <= 1) return 0
    if (sale.kind === 'percent') return 0
    const required = Number(sale.amount)
    if (!required || required <= 1) return 0
    const cur = Number(amount) || 0
    if (cur <= 0) return required
    const mod = cur % required
    const epsilon = 1e-6
    if (Math.abs(mod) < epsilon || Math.abs(mod - required) < epsilon) return 0
    const remaining = round3(Math.ceil(cur / required) * required - cur)
    if (remaining <= epsilon) return 0
    return remaining
}

export function getInlineSaleBarText(sale, amount) {
    if (!sale) return null
    const remaining = getSaleRemaining(sale, amount)
    if (remaining > 0) {
        const formatted = Number.isInteger(remaining) ? String(remaining) : String(Math.round(remaining * 1000) / 1000)
        return `עוד ${formatted} יח' בשביל לקבל את המבצע`
    }
    return getSaleBadgeText(sale)
}

// Only quantity-threshold sales have units worth counting down ("2 for ₪500",
// "buy 2 get 1"); percent, spend-threshold and single-unit sales are already
// reflected in the price, so they get no progress bar.
export function isSaleProgressSale(sale) {
    if (!sale) return false
    if (sale.kind === 'percent' || sale.kind === 'receive-price') return false
    return Number(sale.amount) > 1
}

// Progress line at the top of a listing card.
export function getSaleProgressText(sale, amount) {
    if (!isSaleProgressSale(sale)) return null
    // The bar is a progress indicator, not a sale label: with nothing of this
    // sale in the cart there is no progress to show.
    if (!(Number(amount) > 0)) return null
    const remaining = getSaleRemaining(sale, amount)
    if (remaining > 0) {
        const formatted = Number.isInteger(remaining) ? String(remaining) : String(Math.round(remaining * 1000) / 1000)
        return TR('sale_progress_remaining', { amount: formatted })
    }
    return TR('sale_progress_reached')
}

export function ProductSaleBadge({ product, sales, size = 'm' }) {
    const sale = getFirstSale(product, sales)
    if (!sale) return null
    const label = getSaleBadgeText(sale)
    return <Flex alignItems="center" gap={4} className={classNames(styles.saleBadge, styles[size])}>
        <Icon name="salePercent" size={14} className={styles.saleBadgeIcon} />
        <Text size="s" bold className={styles.saleBadgeText}>{label}</Text>
    </Flex>
}

export function ProductImage({ product, size = 'm', sales, hideSaleBadge = false, className = '' }) {
    const [failed, setFailed] = useState(false)
    useEffect(() => { setFailed(false) }, [product?.id, size])
    const src = product?.id ? getProductImageUrl(product.id, size, '', mainImageHash(product)) : ''
    const saleBadge = hideSaleBadge ? null : <ProductSaleBadge product={product} sales={sales} size={size} />
    if (failed || !src) {
        return <div className={classNames(styles.productImageWrapper, styles[size], className)}>
            <Flex
                center
                className={classNames(styles.productImage, styles[size], styles.productImageFallback)}
            >
                <Icon name="image" size={32} style={{ opacity: 0.35 }} />
            </Flex>
            {saleBadge}
        </div>
    }

    return <div className={classNames(styles.productImageWrapper, styles[size], className)}>
        <Image
            className={classNames(styles.productImage, styles[size])}
            src={src} alt={product.name} loading="eager" onError={() => setFailed(true)} />
        {saleBadge}
    </div>
}

export function isWeightProduct(product) {
    const t = product?.unit?.type
    return t === 'weight' || t === 'WEIGHT'
}

export function getUnitLabel(product) {
    const unit = product?.unit || {}
    const type = unit.type
    const base = unit.baseUnit
    if (type === 'weight') {
        if (base === 'kg') return 'ק"ג'
        if (base === 'g') return 'גרם'
        return 'ק"ג'
    }
    if (base === 'kg') return 'ק"ג'
    if (base === 'g') return 'גרם'
    return "יח'"
}

export function formatAmountNumber(amount) {
    if (amount == null || amount === '') return ''
    const n = Number(amount)
    if (isNaN(n)) return String(amount)
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000)
}

export function formatAmount(product, amount) {
    if (amount == null || amount === '') return ''
    const n = Number(amount)
    if (isNaN(n)) return `${amount} ${getUnitLabel(product)}`
    return `${formatAmountNumber(n)} ${getUnitLabel(product)}`
}

// Brand | net content, e.g. "אסם | 500 גרם". Both are GS1/Comax metadata;
// when either is missing we show only the part we have (and nothing at all
// when both are missing) instead of inventing a weight.
export function getUnitInfoParts(product) {
    if (!product) return { brand: '', netContent: '' }
    return {
        brand: String(product.label || '').trim(),
        netContent: String(product.netContentText || '').trim()
    }
}

// Plain string form for places that need the text itself (e.g. concatenation).
export function getUnitInfoText(product) {
    const { brand, netContent } = getUnitInfoParts(product)
    if (brand && netContent) return `${brand} | ${netContent}`
    return brand || netContent
}

// Render form: only the net content is wrapped in <bdi> so a mixed
// Hebrew/English value cannot reorder around the "|" separator.
export function ProductUnitInfo({ product }) {
    const { brand, netContent } = getUnitInfoParts(product)
    if (brand && netContent) return <>{brand} | <bdi>{netContent}</bdi></>
    return <>{brand || netContent}</>
}

export function ProductInfo(props) {
    const { product, sales, size = 'm', nameLines } = props
    const infoText = getUnitInfoText(product)
    return <Flex gap={4} col className={classNames(styles.info, styles[size])}>
        <ProductPrice {...props} />
        {infoText && <Text size='s' mode='sub'><ProductUnitInfo product={product} /></Text>}
        <Text
            bold
            ellipsis={nameLines}
            className={nameLines ? styles.productName : undefined}
        >
            {product.name}
        </Text>
    </Flex>
}

export function ProductButton({ product, amount = 0, onUpdateAmount, size = 'm', sales = {}, maxAmount = 0 }) {
    // For weight, show amount with unit label (e.g. "1.5 ק\"ג"); for items show "2 יח'"
    // Presentational stepper — caller provides amount and update handler
    // If no handler provided, button is disabled / hidden
    const minAmount = product?.unit?.minAmount || 1
    const step = product?.unit?.step || 1
    const max = Number(maxAmount ?? 0) || 0
    const atMax = max > 0 && Number(amount ?? 0) >= max
    const maxTitle = atMax ? `הגעת למגבלת כמות (${max})` : undefined

    if (!amount) {
        return <Flex className={classNames(styles.productButton, styles[size])} >
            <Button
                icon='add' preventDefault stopPropagation
                onClick={() => onUpdateAmount?.(round3(minAmount) || 1)}
                disabled={!onUpdateAmount}
            >add_to_cart</Button>
        </Flex >
    }

    const displayAmount = formatAmount(product, amount)
    const handleInc = () => {
        const next = round3(amount + step)
        if (max > 0 && next > max) return
        onUpdateAmount?.(next)
    }
    const handleDec = () => {
        const next = round3(amount - step)
        onUpdateAmount?.(next <= 0 ? 0 : next)
    }

    return <Flex
        onClick={e => {
            e.preventDefault()
            e.stopPropagation()
        }}
        className={classNames(styles.productButton, styles[size], styles.stepper)}>
        <Button icon='add' preventDefault stopPropagation onClick={handleInc} disabled={!onUpdateAmount || atMax} title={maxTitle} />
        <Text size='m' bold className={styles.amount}>{displayAmount}</Text>
        <Button preventDefault stopPropagation onClick={handleDec} disabled={!onUpdateAmount}>-</Button>
    </Flex>
}

// Favourite heart. State lives in the User context (persisted per logged-in
// user); this component stays presentational so it can render anywhere.
// Off = outline, on = the same heart filled (see .on in product.module.css).
export function ProductFavorite({ on = false, onToggle, className }) {
    return <Button
        mode='text'
        icon='heart'
        onClick={onToggle}
        stopPropagation
        preventDefault
        aria-label='favorite'
        className={classNames(styles.favorite, [styles.on, on], className)}
    />
}

// Row of kashrut + diet stamps. Cards show one kashrut stamp (strongest
// rabbinate with an image) and a couple of diet icons. The product page shows
// more (kashrutCount / dietCount) and falls back to a text badge per rabbinate
// without an image. min-height is set in CSS so cards don't reflow.
export function ProductStamps({ product, className, kashrutCount = 1, dietCount = 2, imagesOnly = true }) {
    if (!product) return null
    return <Flex gap={6} alignItems="center" wrap justifyContent='space-between' className={classNames(styles.stamps, className)}>
        <KashrutStamps
            kashrut={product.kashrut}
            count={kashrutCount}
            imagesOnly={imagesOnly}
        />
        <DietIcons diet={product.diet} count={dietCount} />
    </Flex>
}

// Row (line) price — the total of the whole cart line instead of the unit
// price. Used by the cart rows, where the amount is already on screen.
// The discount colour follows the money, not the promo: a bundle that has not
// reached its size yet is still a regular price.
function RowPrice({ product, size, sales, saleTotalAmount }) {
    const row = getRowPriceInfo(product)
    if (!row) return null

    const sale = getFirstSale(product, sales)
    const bundlePending = !isBundleReached(sale, saleTotalAmount != null ? saleTotalAmount : row.amount)
    const hasDiscount = row.hasDiscount && !bundlePending
    const total = bundlePending ? row.regular : row.total
    const unitPrice = row.amount > 0 ? round2(total / row.amount) : row.unitPrice

    const CurrencySymbol = <Text size='s' bold>₪</Text>
    const unitPriceText = getUnitPriceText(product, unitPrice)

    return <Flex
        gap={8}
        alignItems='center'
        wrap
        className={classNames(styles.price, styles[size], hasDiscount ? styles.priceDiscount : styles.priceRegular)}
    >
        <Text size='xxl' bold className={styles.rowTotal}>{CurrencySymbol}{formatPrice(total)}</Text>
        {hasDiscount && <Text size='s' lineThrough className={styles.regularPrice}>{CurrencySymbol}{formatPrice(row.regular)}</Text>}
        {unitPriceText && <Text size='s' mode='sub' className={styles.forgrams}>{unitPriceText}</Text>}
        {row.amount > 1 && <Text size='s' mode='sub' className={styles.unitPriceHint}>{formatPrice(unitPrice)} × {formatAmountNumber(row.amount)}</Text>}
    </Flex>
}

export function ProductPrice({ product, size = 'm', sales, priceMode = 'unit', saleTotalAmount }) {
    try {
        const price = product.price
        if (price == null) return null
        const sale = getFirstSale(product, sales)
        const saleInfo = sale ? getSalePriceInfo(product, sale) : null
        // Show per-100g/ml for the effective price: sale unit price when on sale, regular otherwise.
        const unitPriceText = getUnitPriceText(product, saleInfo?.saleSingle)

        const CurrencySymbol = <Text size='s' bold>₪</Text>
        if (priceMode === 'row') {
            const row = getRowPriceInfo(product)
            // A row price only makes sense for a cart line: it has an amount
            // and a server-calculated line total. Anything else (a catalog
            // product, e.g. a search result) keeps the unit price.
            if (row && row.amount > 0) {
                return <RowPrice product={product} size={size} sales={sales} saleTotalAmount={saleTotalAmount} />
            }
        }
        if (saleInfo) {
            const isBundle = saleInfo.isBundle
            const saleText = isBundle
                ? <Text size='xxl' bold className={styles.salePrice}>
                    {saleInfo.amount} ב-{CurrencySymbol}{formatPrice(saleInfo.saleTotal)}
                </Text>
                : <Text size='xxl' bold className={styles.salePrice}>{CurrencySymbol}{formatPrice(saleInfo.saleSingle)}</Text>
            return <Flex gap={8} alignItems='center' wrap className={classNames(styles.price, styles[size], styles.sale)}>
                <Text size='xxl' bold className={styles.salePrice}>{saleText}</Text>
                <Text size='s' lineThrough className={styles.regularPrice}>{CurrencySymbol}{formatPrice(saleInfo.regular)}</Text>
                {unitPriceText && <Text size='s' mode='sub' className={styles.forgrams}>{unitPriceText}</Text>}
            </Flex>
        }

        return <Flex gap={8} alignItems='center' wrap className={classNames(styles.price, styles[size])}>
            <Text size='xxl' bold className={styles.basePrice}>{CurrencySymbol}{formatPrice(price)}</Text>
            {unitPriceText && <Text size='s' mode='sub' className={styles.forgrams}>{unitPriceText}</Text>}
        </Flex>

    } catch (error) {
        return null
    }
}


export { getUnitPriceText, parseWeightOrVolume }
