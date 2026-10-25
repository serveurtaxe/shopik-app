import { useState } from 'react'
import ScanProduct from './ScanProduct'
import ReplaceProduct from './ReplaceProduct'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import Button from 'common/components/Button'
import Image from 'common/components/Image'
import styles from './productPickModal.module.css'
import { isWeightProduct, formatAmount, getUnitLabel, getUnitInfoText } from 'common/components/Product'
import { getProductImageUrls } from 'common/functions/productImageUrl.js'

export default function ProductPickModal({ product = {}, orderId, onClose, onPicked }) {
    const weight = isWeightProduct(product)
    const isScanned = product.finalAmount != null || !!product.missing
    const [phase, setPhase] = useState(isScanned ? 'amount' : 'details')
    const initialSupplied = isScanned ? (product.missing ? '' : String(product.finalAmount ?? '')) : ''

    if (phase === 'details') {
        return <ProductDetails
            product={product}
            orderId={orderId}
            onClose={onClose}
            onPicked={onPicked}
            onScan={() => setPhase(weight ? 'weight' : 'scanning')}
            onReplace={() => setPhase('replace')}
        />
    }

    if (phase === 'replace') {
        return <ReplaceProduct
            product={product}
            orderId={orderId}
            onClose={onClose}
            onPicked={onPicked}
        />
    }

    if (phase === 'weight') {
        return <ScanProduct
            product={product}
            orderId={orderId}
            onClose={onClose}
            onPicked={onPicked}
            initialPhase="weight"
            initialSupplied={initialSupplied}
            initialBarcode={product.barcode}
            onReplace={() => setPhase('replace')}
            resettable={isScanned}
        />
    }

    const initialPhase = phase === 'amount' ? 'amount' : 'scanning'
    return <ScanProduct
        product={product}
        orderId={orderId}
        onClose={onClose}
        onPicked={onPicked}
        initialPhase={initialPhase}
        initialSupplied={initialSupplied}
        initialBarcode={product.barcode}
        onReplace={() => setPhase('replace')}
        resettable={isScanned}
    />
}

function ProductDetails({ product = {}, orderId, onClose, onPicked, onScan, onReplace }) {
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')
    const [imgIdx, setImgIdx] = useState(0)

    const productImages = product?.images?.product || []
    const threeSixty = product?.images?.threeSixty || []
    const has360 = threeSixty.length > 0 || productImages.length > 1
    const displayImages = getProductImageUrls(product?.id, productImages, 'l')
    const mainSrc = displayImages[imgIdx] || ''
    const dots = displayImages.length > 1 ? displayImages : (has360 ? Array.from({ length: 5 }) : [])

    const price = product.price ?? product.prices?.[0]?.price ?? 36
    const barcode = product.barcode || ''
    const storageType = product.storageType
    const isCold = storageType === 'cold' || storageType === 'freeze'
    const ordered = product.amount ?? 1
    const orderedLabel = formatAmount(product, ordered)
    const unitInfo = getUnitInfoText(product)
    const weight = isWeightProduct(product)
    const unitLabel = getUnitLabel(product)
    const recommendations = product.picking?.recommendations

    return <Flex col className={styles.pickModal}>
        <div className={styles.imageWrap}>
            {has360 && (
                <button type="button" className={styles.view360} onClick={() => setImgIdx(i => (i + 1) % Math.max(displayImages.length, 1))}>
                    <span>360°</span>
                </button>
            )}
            {mainSrc ? (
                <Image src={mainSrc} alt={product.name} width={200} height={200} className={styles.mainImage} />
            ) : (
                <div className={styles.placeholder}><Icon name="products" size={32} /></div>
            )}
            {dots.length > 0 && (
                <div className={styles.dots}>
                    {dots.map((_, idx) => (
                        <span key={idx} className={idx === imgIdx ? styles.active : ''} onClick={() => setImgIdx(idx)} style={{ cursor: 'pointer' }} />
                    ))}
                </div>
            )}
            <div className={styles.priceTop}>
                <Icon name={isCold ? 'snow' : 'stock'} size={14} />
                <Text size="m" bold>₪{price}</Text>
            </div>
        </div>

        <Flex col gap={8} className={styles.body}>
            {barcode && <Flex alignItems="center" gap={4} className={styles.barcodeRow}>
                <Icon name="barcode" size={12} />
                <Text size="xs" mode="sub">{barcode}</Text>
            </Flex>}
            <Text bold size="m" className={styles.productName}>{product.name || 'מוצר'}</Text>
            <Text size="xs" mode="sub">{unitInfo ? `${unitInfo} • ` : ''}הוזמן: {orderedLabel}</Text>

            {/*  <Flex col gap={8} className={styles.infoRows}>
                <Flex gap={8} alignItems="center">
                    <Icon name="location" size={16} className={styles.rowIcon} />
                    <Text size="xs">{isCold ? 'אזור קירור • מעבר 16 • מדף 4' : 'אזור רגיל • מעבר 16 • מדף 4'}</Text>
                </Flex>
                {recommendations ? (
                    <Flex gap={8} alignItems="center">
                        <Icon name="note" size={16} className={styles.rowIcon} />
                        <Text size="xs">{recommendations}</Text>
                    </Flex>
                ) : (
                    <Flex gap={8} alignItems="center">
                        <Icon name="note" size={16} className={styles.rowIcon} />
                        <Text size="xs">יש לבדוק תוקף ולוודא אריזה תקינה</Text>
                    </Flex>
                )}
                <Flex gap={8} alignItems="center">
                    <Icon name={isCold ? 'snow' : 'stock'} size={16} className={styles.rowIcon} />
                    <Text size="xs">{isCold ? 'לשמור בקירור, לאחסן בנפרד' : 'פלסטיק צריך לקשור, צורה בר הבחנה'}</Text>
                </Flex>
            </Flex> */}

            {error && <Text size="s" mode="error">{error}</Text>}

            <Flex col gap={10} className={styles.actions}>
                <Button loading={loading} onClick={onScan} className={styles.scanBtn}>{weight ? 'הזן משקל' : 'סריקה מוצר'}</Button>
                <Button mode="outline" loading={loading} onClick={onReplace || onScan} className={styles.missingBtn}>מוצר חסר</Button>
            </Flex>
        </Flex>
    </Flex>
}
