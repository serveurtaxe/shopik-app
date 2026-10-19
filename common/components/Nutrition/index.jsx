import Icon from 'common/components/Icon'
import Image from 'common/components/Image'
import Flex from 'common/components/Flex'
import classNames from 'common/functions/classNames'
import styles from './nutrition.module.css'
import { selectDietIcons, selectFoodSymbols } from './constants.js'
import { getFoodSymbolImage } from './images.js'

// Diet claims (אורגני, טבעוני, ללא גלוטן, …) as line icons. Shown on the card
// (a couple) and the product page (more).
export function DietIcons({ diet, count = 2, size = 18, className }) {
    const entries = selectDietIcons(diet, count)
    if (!entries.length) return null
    return <Flex gap={6} alignItems="center" wrap className={classNames(styles.icons, className)}>
        {entries.map(entry => <Icon
            key={entry.key}
            name={entry.icon}
            size={size}
            title={entry.label}
            className={styles.icon}
        />)}
    </Flex>
}

// Colored circle stamps (red "high in", green symbol) as bundled images.
// Product page only — cards never render these.
export function FoodSymbolStamps({ nutrients, className }) {
    const symbols = selectFoodSymbols(nutrients)
        .map(symbol => ({ ...symbol, src: getFoodSymbolImage(symbol) }))
        .filter(symbol => symbol.src)
    if (!symbols.length) return null
    return <Flex gap={6} alignItems="center" wrap className={classNames(styles.symbols, className)}>
        {symbols.map(symbol => <Image
            key={symbol.key}
            src={symbol.src}
            alt={symbol.label}
            title={symbol.label}
            className={styles.symbol}
        />)}
    </Flex>
}

export default DietIcons
