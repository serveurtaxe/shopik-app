import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router'
import apiReq from '#common/functions/apiReq.js'
import Loader from '#common/components/Loader'
import { setSalesCache } from '#common/functions/salesCache.js'
import Flex from '#common/components/Flex'
import Image from '#common/components/Image'
import Text from '#common/components/Text'
import Button from '#common/components/Button'
import Card from '#common/components/Card'
import Collapse from '#common/components/Collapse'
import Badge from '#common/components/Badge'
import HorizontalScroll from '#common/components/HorizontalScroll'
import Icon from '#common/components/Icon'
import classNames from '#common/functions/classNames'
import styles from './product.module.css'
import Breadcrumbs from 'components/Breadcrumbs'
import NotFound from 'pages/NotFound'
import { usePage } from 'layout/Page'
import TR from '#common/texts/TR.js'
import { ProductButton } from 'pages/Products/ProductCard'
import ProductCard from 'pages/Products/ProductCard'
import { useProductCart } from '#common/components/Product/useProductCart.js'
import {
    ProductPrice,
    ProductSaleBadge,
    ProductStamps,
    getFirstSale,
    getUnitInfoText
} from 'common/components/Product'
import { selectKashrutStamps, getSupervisionLabel } from 'common/components/Kashrut/constants.js'
import { FoodSymbolStamps } from 'common/components/Nutrition'
import { selectDietIcons, selectFoodSymbols } from 'common/components/Nutrition/constants.js'
import { getProductState } from '#common/functions/productState.js'

const PASSOVER_TEXT = {
    kosher: 'passover_kosher',
    'not-kosher': 'passover_not_kosher',
    special: 'passover_mehadrin',
    'not-relevant': ''
}

const STORAGE_TEXT = {
    regular: 'storage_regular',
    cold: 'storage_cold',
    freeze: 'storage_freeze',
    extra: 'storage_extra'
}

function gs1Text(value) {
    if (value == null || value === '') return ''
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (Array.isArray(value)) {
        const parts = value
            .map(v => gs1Text(v?.value ?? v))
            .filter(Boolean)
        return parts.join(', ')
    }
    if (typeof value === 'object') {
        if (value.value != null && value.value !== '') return String(value.value)
        const vals = Object.values(value).map(gs1Text).filter(Boolean)
        return vals.join(', ')
    }
    return ''
}

function nutritionPairs(nutrition) {
    // Real GS1 shape: nutrition.main.table.rows[] = { label, code, fields: [{ text }] }
    const tableRows = nutrition?.main?.table?.rows
    if (Array.isArray(tableRows) && tableRows.length) {
        return tableRows
            .map((r, i) => ({
                id: r?.code || `n${i}`,
                name: r?.label || '',
                text: r?.fields?.[0]?.text || [r?.fields?.[0]?.value, r?.fields?.[0]?.UOM].filter(Boolean).join(' ')
            }))
            .filter(p => p.name || p.text)
            .slice(0, 20)
    }
    // Fallback for other shapes: nutrition.main / additional as arrays or maps
    const rows = []
    const pushSection = (section) => {
        if (!section) return
        if (Array.isArray(section)) {
            section.forEach((entry, i) => {
                if (entry == null) return
                if (typeof entry === 'object') {
                    const name = gs1Text(entry.name || entry.nutrient || entry.title || entry.label || entry.code)
                    const text = entry.text || [gs1Text(entry.value ?? entry.amount ?? entry.quantity), gs1Text(entry.unit || entry.uom || '')].filter(Boolean).join(' ')
                    rows.push({ id: `f${i}-${name}`, name, text: text || gs1Text(entry) })
                } else {
                    rows.push({ id: `f${i}`, name: '', text: String(entry) })
                }
            })
        } else if (typeof section === 'object') {
            Object.entries(section).forEach(([k, v]) => {
                if (k === 'table') return
                const text = gs1Text(v)
                if (text) rows.push({ id: k, name: k, text })
            })
        }
    }
    pushSection(nutrition?.main)
    pushSection(nutrition?.additional)
    return rows.filter(p => p.name || p.text).slice(0, 20)
}

function buildSections(product) {
    const gs1 = product?.gs1 || {}
    const sections = []

    const kashrutLines = []
    const kashrutParts = []
    const supervision = getSupervisionLabel(product?.kashrut)
    if (supervision) kashrutParts.push(supervision)
    const rabbinateNames = selectKashrutStamps(product?.kashrut, Infinity).map(s => s.name).filter(Boolean)
    if (rabbinateNames.length) kashrutParts.push(rabbinateNames.join(', '))
    if (kashrutParts.length) kashrutLines.push({ label: 'product_kashrut', value: kashrutParts.join(' · ') })
    const pass = PASSOVER_TEXT[product?.passoverKashrut]
    if (pass) kashrutLines.push({ label: 'product_passover_kashrut', value: pass })
    if (kashrutLines.length) {
        sections.push({ key: 'kashrut', title: 'product_kashrut', icon: 'check', lines: kashrutLines })
    }

    const productLines = []
    const origin = gs1Text(gs1.origin)
    if (origin) productLines.push({ label: 'product_origin', value: origin })
    if (product?.producer) productLines.push({ label: 'producer', value: product.producer })
    const importer = gs1Text(gs1?.ids?.manufacturer?.name)
    if (importer && importer !== product?.producer) productLines.push({ label: 'product_importer', value: importer })
    if (product?.label) productLines.push({ label: 'label', value: product.label })
    const net = gs1Text(gs1.netContent?.text || gs1.netContent)
    if (net) productLines.push({ label: 'product_content', value: net })
    const storageInstr = gs1Text(gs1?.serving?.storage)
    if (storageInstr) productLines.push({ label: 'product_storage_instr', value: storageInstr })
    else if (product?.storageType) productLines.push({ label: 'product_storage', value: STORAGE_TEXT[product.storageType] || product.storageType })
    if (product?.shelflife) productLines.push({ label: 'product_shelf_life', value: `${product.shelflife} ${TR('days_suffix')}` })
    else if (gs1Text(gs1.shelfLife)) productLines.push({ label: 'product_shelf_life', value: gs1Text(gs1.shelfLife) })
    if (productLines.length) {
        sections.push({ key: 'details', title: 'product_details', icon: 'info', lines: productLines })
    }

    if (product?.regulatoryInfo) {
        sections.push({ key: 'ingredients', title: 'product_ingredients', icon: 'clipboardList', body: product.regulatoryInfo })
    }

    const nutrientFlags = []
    if (product?.nutrients?.sugar) nutrientFlags.push('nutrient_high_sugar')
    if (product?.nutrients?.sodium) nutrientFlags.push('nutrient_high_sodium')
    if (product?.nutrients?.fat) nutrientFlags.push('nutrient_high_fat')
    if (product?.nutrients?.alcohol) nutrientFlags.push('nutrient_alcohol')
    const pairs = nutritionPairs(gs1?.nutrition)
    const servingText = gs1Text(gs1?.serving?.suggestion || gs1?.serving?.size)
    if (nutrientFlags.length || pairs.length || servingText) {
        sections.push({
            key: 'nutrition',
            title: 'nutrition_values',
            icon: 'calculator',
            flags: nutrientFlags,
            pairs,
            extra: servingText
        })
    }

    const marketing = gs1Text(gs1?.marketing?.messages)
    const desc = [product?.description, marketing].filter(Boolean).join('\n\n')
    if (desc) {
        sections.push({ key: 'desc', title: 'product_description', icon: 'note', body: desc })
    }

    return sections
}

function SectionBody({ section }) {
    if (!section) return null
    return (
        <Flex col gap={0}>
            {section.lines?.map((l, i) => (
                <Flex key={i} justifyContent="space-between" gap={12} className={styles.kvRow}>
                    <Text size="s" bold className={styles.kvLabel}>{l.label}</Text>
                    <Text size="s" className={styles.kvValue}>{l.value}</Text>
                </Flex>
            ))}
            {section.flags?.length > 0 && (
                <Flex gap={6} wrap className={styles.flagWrap}>
                    {section.flags.map(f => (
                        <Badge key={f} className={styles.flag}><Text size="s">{f}</Text></Badge>
                    ))}
                </Flex>
            )}
            {section.pairs?.length > 0 && (
                <div className={styles.nutGrid}>
                    {section.pairs.map(p => (
                        <Flex key={p.id} justifyContent="space-between" gap={8} className={styles.nutCell}>
                            <Text size="s" bold>{p.name}</Text>
                            <Text size="s">{p.text}</Text>
                        </Flex>
                    ))}
                </div>
            )}
            {section.extra && <Text size="s" mode="sub" className={styles.specExtra}>{section.extra}</Text>}
            {section.body && <Text size="s" className={styles.specBody}>{section.body}</Text>}
        </Flex>
    )
}

export default function Product() {
    const [selectedImageIndex, setSelectedImageIndex] = useState(0)
    const [wishlisted, setWishlisted] = useState(false)
    const [activeSpecKey, setActiveSpecKey] = useState(null)
    const { productId } = useParams()
    const { loading, pageData } = usePage()
    const { data } = pageData
    const { product, sales, categoryPath, related, relatedSales } = data || {}
    const mergedSales = useMemo(() => ({ ...(relatedSales || {}), ...(sales || {}) }), [sales, relatedSales])
    useEffect(() => { if (sales) setSalesCache(sales) }, [sales])
    useEffect(() => { if (data?.sales) setSalesCache(data.sales) }, [data])
    useEffect(() => { if (mergedSales && Object.keys(mergedSales).length) setSalesCache(mergedSales) }, [mergedSales])
    useEffect(() => { setSelectedImageIndex(0); setWishlisted(false); setActiveSpecKey(null) }, [productId, product?.id])

    const productImages = (product?.images?.product || []).filter(img => img?.sizes)
    const images = productImages.length
        ? productImages.map(img => img.sizes.xl || img.sizes.l || img.sizes.m)
        : []
    const thumbImages = productImages.length
        ? productImages.map(img => img.sizes.m || img.sizes.s || img.sizes.l || img.sizes.xl)
        : []
    const mainImage = images[selectedImageIndex] || images[0] || ''
    const has360 = (product?.images?.threeSixty || []).length > 0
    const sections = useMemo(() => buildSections(product || {}), [product])
    const { amount: cartAmount } = useProductCart(product || {}, sales || {})
    const activeSection = sections.find(s => s.key === activeSpecKey) || sections[0]
    const relatedList = (related || []).filter(p => p?.id !== product?.id)

    if (loading) {
        return <Flex className={styles.container}><Loader /></Flex>
    }

    if (!product) {
        if (pageData?.notFound) return <NotFound />
        return <Flex className={styles.container}><Text>product_not_found</Text></Flex>
    }

    // Same state contract as the card / inline — the detail page's price, sale
    // badge and buy button all read the --pc-* vars, so it stays consistent
    // with the listing instead of falling back to the old green/red defaults.
    const detailState = getProductState({
        amount: cartAmount,
        sale: getFirstSale(product, sales || {}),
    })

    return (
        <Flex col className={styles.container}
            data-action={detailState.action}
            data-price={detailState.price}>
            <div className={styles.crumbs}>
                <Breadcrumbs path={categoryPath ? `products/${categoryPath}` : 'products'} />
            </div>

            <div className={styles.body}>
                <div className={styles.infoMain}>
                    <div className={styles.priceRow}>
                        <ProductPrice product={product} sales={sales} size="l" />
                        <Button
                            mode="text"
                            icon="heart"
                            aria-label={TR('aria_wishlist')}
                            className={classNames(styles.wish, wishlisted && styles.wishActive)}
                            onClick={() => setWishlisted(w => !w)}
                        />
                    </div>

                    {getUnitInfoText(product) && (
                        <Text size="s" mode="sub" className={styles.labelLine}>
                            {getUnitInfoText(product)}
                        </Text>
                    )}

                    <Text size="h1" bold className={styles.productName}>
                        {product.name}
                    </Text>

                    {product.barcode && (
                        <Flex className={styles.barcodeRow} gap={6} alignItems="center">
                            <Icon name="barcode" size={20} className={styles.barcodeIcon} />
                            <Text size="s" mode="sub">{product.barcode}</Text>
                        </Flex>
                    )}

                    {(() => {
                        const supervisionLabel = getSupervisionLabel(product.kashrut)
                        const hasPassover = !!PASSOVER_TEXT[product.passoverKashrut]
                        const hasStamps = selectKashrutStamps(product.kashrut, 1).length > 0
                        const hasDiet = selectDietIcons(product.diet, 1).length > 0
                        const hasSymbols = selectFoodSymbols(product.nutrients).length > 0
                        if (!supervisionLabel && !hasPassover && !hasStamps && !hasDiet && !hasSymbols) return null
                        return (
                            <Flex className={styles.badgeRow} gap={6} wrap alignItems="center">
                                <ProductStamps product={product} kashrutCount={2} dietCount={6} imagesOnly={false} />
                                {supervisionLabel && <Badge><Text size="s">{supervisionLabel}</Text></Badge>}
                                {hasPassover && (
                                    <Badge><Text size="s">{PASSOVER_TEXT[product.passoverKashrut]}</Text></Badge>
                                )}
                                <FoodSymbolStamps nutrients={product.nutrients} />
                            </Flex>
                        )
                    })()}
                </div>

                <div className={styles.gallery}>
                    <div className={styles.mainImageWrapper}>
                        <Image
                            src={mainImage}
                            alt={product.name}
                            width="100%"
                            height="100%"
                            className={styles.mainImage}
                        />
                        <ProductSaleBadge product={product} sales={sales} size="m" />
                        {has360 && (
                            <Badge className={styles.spin360}>
                                <Flex gap={4} alignItems="center">
                                    <Icon name="refresh" size={14} />
                                    <Text size="s">360°</Text>
                                </Flex>
                            </Badge>
                        )}
                    </div>

                    {images.length > 1 && (
                        <>
                            <Flex className={styles.dots} gap={6} justifyContent="center" role="tablist" aria-label={TR('aria_product_images')}>
                                {images.map((_, idx) => (
                                    <Button
                                        key={idx}
                                        mode="text"
                                        aria-label={`${TR('aria_product_image')} ${idx + 1}`}
                                        className={classNames(styles.dot, idx === selectedImageIndex && styles.dotActive)}
                                        onClick={() => setSelectedImageIndex(idx)}
                                    />
                                ))}
                            </Flex>
                            <HorizontalScroll
                                className={styles.thumbnails}
                                items={thumbImages.map((img, idx) => (
                                    <Image
                                        key={`${img}-${idx}`}
                                        src={img}
                                        alt={`${product.name} ${idx + 1}`}
                                        className={classNames(styles.thumbnail, idx === selectedImageIndex && styles.active)}
                                        onClick={() => setSelectedImageIndex(idx)}
                                        data-active={idx === selectedImageIndex || undefined}
                                    />
                                ))}
                            />
                        </>
                    )}
                </div>

                <div className={styles.purchase}>
                    <ProductButton product={product} sales={sales || {}} />
                </div>

                <div className={styles.specs}>
                    <Card className={styles.specCard}>
                        {sections.length > 0 && (
                            <>
                                <div className={styles.specLayout}>
                                    <Flex col gap={2} className={styles.specNav}>
                                        {sections.map(s => (
                                            <Button
                                                key={s.key}
                                                mode="text"
                                                icon={s.icon}
                                                className={classNames(
                                                    styles.specTab,
                                                    activeSection?.key === s.key && styles.specTabActive
                                                )}
                                                onClick={() => setActiveSpecKey(s.key)}
                                            >
                                                <Text size="s" bold={activeSection?.key === s.key}>{s.title}</Text>
                                            </Button>
                                        ))}
                                    </Flex>
                                    <div className={styles.specContent}>
                                        {activeSection && <SectionBody section={activeSection} />}
                                    </div>
                                </div>
                                <Flex col gap={8} className={styles.collapses}>
                                    {sections.map((s, i) => (
                                        <Collapse
                                            key={s.key}
                                            defaultOpen={i === 0}
                                            title={
                                                <Flex gap={8} alignItems="center">
                                                    <Icon name={s.icon} size={16} />
                                                    <Text size="s" bold>{s.title}</Text>
                                                </Flex>
                                            }
                                        >
                                            <SectionBody section={s} />
                                        </Collapse>
                                    ))}
                                </Flex>
                            </>
                        )}
                        <Text size="xs" mode="sub" className={styles.disclaimer}>
                            product_disclaimer
                        </Text>
                    </Card>
                </div>
            </div>

            {relatedList.length > 0 && (
                <div className={styles.related}>
                    <Text size="h2" bold className={styles.relatedTitle}>related_products</Text>
                    <HorizontalScroll
                        className={styles.relatedScroll}
                        items={relatedList.map(p => {
                            const psales = (p.saleIds || []).reduce((acc, sId) => {
                                if (mergedSales[sId]) acc[sId] = mergedSales[sId]
                                return acc
                            }, {})
                            return (
                                <div key={p.id} className={styles.relatedCard}>
                                    <ProductCard product={p} sales={psales} size="m" />
                                </div>
                            )
                        })}
                    />
                </div>
            )}
        </Flex>
    )
}

Product.init = async function (path) {
    const productId = path.split('/').pop()
    const res = await apiReq('product/get', { id: productId })
    const product = res.products?.[0]

    if (!product) {
        return { notFound: true, title: '404' }
    }

    let related = []
    let relatedSales = {}
    try {
        const catId = product?.category?.pathIds?.slice(-1)?.[0] || product?.category?.id
        if (catId) {
            const rel = await apiReq('product/get', {
                filter: { 'category.pathIds': catId },
                limit: 11
            })
            related = (rel.products || []).filter(p => p.id !== product.id).slice(0, 10)
            relatedSales = rel.sales || {}
        }
    } catch {
        related = []
    }

    return {
        title: product.name,
        description: product.description || product.name,
        data: { product, sales: res.sales, categoryPath: res.categoryPath, related, relatedSales }
    }
}
