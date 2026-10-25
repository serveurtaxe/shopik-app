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
import { getProductImageUrl } from 'common/functions/productImageUrl.js'
import { useState, useEffect } from 'react'
import { getSalesCache } from '#common/functions/salesCache.js'

export function getFirstSale(product, sales) {
    const saleId = product?.saleIds?.[0]
    if (!saleId) return null
    if (sales && sales[saleId]) return sales[saleId]
    try {
        const cache = getSalesCache?.()
        if (cache && cache[saleId]) return cache[saleId]
    } catch { }
    return null
}

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

export function getSalePriceInfo(product, sale) {
    if (!sale || !product) return null
    const regular = Number(product.price)
    if (isNaN(regular)) return null
    const amount = Number(sale.amount) || 1
    const kind = sale.kind
    const price = sale.price
    const percent = sale.percent
    let saleSingle = null
    let saleTotal = null
    if (kind === 'percent' && percent != null) {
        const p = Number(percent)
        saleSingle = round2(regular * (1 - p / 100))
        saleTotal = round2(saleSingle * amount)
    } else if (price != null) {
        const total = Number(price)
        saleTotal = round2(total)
        saleSingle = amount > 1 ? round2(total / amount) : saleTotal
    } else {
        return null
    }
    if (saleSingle < 0) saleSingle = 0
    if (saleTotal < 0) saleTotal = 0
    return { regular, saleSingle, saleTotal, amount, kind, isBundle: amount > 1 }
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

export function ProductSaleBadge({ product, sales, size = 'm' }) {
    const sale = getFirstSale(product, sales)
    if (!sale) return null
    const label = getSaleBadgeText(sale)
    return <Flex alignItems="center" gap={4} className={classNames(styles.saleBadge, styles[size])}>
        <Icon name="salePercent" size={14} className={styles.saleBadgeIcon} />
        <Text size="s" bold className={styles.saleBadgeText}>{label}</Text>
    </Flex>
}

export function ProductImage({ product, size = 'm', sales, hideSaleBadge = false }) {
    const [failed, setFailed] = useState(false)
    useEffect(() => { setFailed(false) }, [product?.id, size])
    const src = product?.id ? getProductImageUrl(product.id, size) : ''
    const saleBadge = hideSaleBadge ? null : <ProductSaleBadge product={product} sales={sales} size={size} />
    if (failed || !src) {
        return <div className={classNames(styles.productImageWrapper, styles[size])}>
            <Flex
                center
                className={classNames(styles.productImage, styles[size], styles.productImageFallback)}
            >
                <Icon name="image" size={32} style={{ opacity: 0.35 }} />
            </Flex>
            {saleBadge}
        </div>
    }

    return <div className={classNames(styles.productImageWrapper, styles[size])}>
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

export function formatAmount(product, amount) {
    if (amount == null || amount === '') return ''
    const n = Number(amount)
    if (isNaN(n)) return `${amount} ${getUnitLabel(product)}`
    const str = Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000)
    return `${str} ${getUnitLabel(product)}`
}

// Brand | net content, e.g. "אסם | 500 גרם". Both are GS1/Comax metadata;
// when either is missing we show only the part we have (and nothing at all
// when both are missing) instead of inventing a weight.
export function getUnitInfoText(product) {
    if (!product) return ''
    const brand = String(product.label || '').trim()
    const netContent = String(product.netContentText || '').trim()
    if (brand && netContent) return `${brand} | ${netContent}`
    return brand || netContent
}

export function ProductInfo(props) {
    const { product, sales, size = 'm' } = props
    const infoText = getUnitInfoText(product)
    return <Flex gap={4} col className={classNames(styles.info, styles[size])}>
        <ProductPrice {...props} />
        {infoText && <Text size='xs' mode='sub'>{infoText}</Text>}
        <Text bold>{product.name}</Text>
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

// Visual-only favourite toggle. No persistence / API yet — state is local so
// the heart is wired into the card layout and can be lifted later without a
// redesign. Colours come from --product-favorite-color.
export function ProductFavorite({ className }) {
    const [on, setOn] = useState(false)
    return <Button
        mode='text'
        icon={on ? 'heartPlus' : 'heart'}
        onClick={() => setOn(o => !o)}
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

export function ProductPrice({ product, size = 'm', sales }) {
    try {
        const price = product.price
        if (price == null) return null
        const unitPriceText = getUnitPriceText(product)
        const sale = getFirstSale(product, sales)
        const saleInfo = sale ? getSalePriceInfo(product, sale) : null

        const CurrencySymbol = <Text size='s' bold>₪</Text>
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

        return <Flex gap={20} alignItems='center' className={classNames(styles.price, styles[size])}>
            <Text size='xxl' bold className={styles.basePrice}>{CurrencySymbol}{formatPrice(price)}</Text>
            {unitPriceText && <Text size='s' mode='sub' className={styles.forgrams}>{unitPriceText}</Text>}
        </Flex>

    } catch (error) {
        return null
    }
}

export function getUnitPriceText({ unitType, unitBase, unitAmount, unit }) {
    // support both product.unit and flat unitType/unitBase/unitAmount
    const type = unitType || unit?.type
    const base = unitBase || unit?.baseUnit
    const amount = unitAmount || unit?.amount || unit?.units
    if (type === 'weight' && base === 'g' && amount) {
        return `${(amount * 100).toFixed(0)}ג ל-100ג`
    }
    if (type === 'weight' && base === 'kg' && amount) {
        return `${(amount * 100).toFixed(0)}ג ל-100ג`
    }
    if (type === 'pack' && amount) {
        return `x${amount}`
    }
    return ''
}
