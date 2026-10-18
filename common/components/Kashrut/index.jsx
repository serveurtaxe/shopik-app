import Image from 'common/components/Image'
import Text from 'common/components/Text'
import Badge from 'common/components/Badge'
import Flex from 'common/components/Flex'
import classNames from 'common/functions/classNames'
import styles from './kashrut.module.css'
import { selectKashrutStamps } from './constants.js'
import { getKashrutImage } from './images.js'

// A single kashrut stamp: the bundled image when one exists, otherwise the
// rabbinate's name as a text badge (see the product page fallback rule).
export function KashrutStamp({ entry, className }) {
    if (!entry) return null
    const src = getKashrutImage(entry.stampCode)
    if (src)
        return <Image
            src={src}
            alt={entry.name}
            className={classNames(styles.stamp, className)}
        />
    return <Badge className={classNames(styles.textStamp, className)}>
        <Text size="xs" bold>{entry.name}</Text>
    </Badge>
}

// Row of kashrut stamps. `count` caps how many rabbinates are shown — 1 on the
// product card, 2+ on the product page (passed down via ProductStamps).
// `imagesOnly` prefers stamps that have an image (card behavior) and only falls
// back to the strongest text stamp when no rabbinate has one.
export function KashrutStamps({ kashrut, count = 1, imagesOnly = false, className }) {
    let entries = imagesOnly
        ? selectKashrutStamps(kashrut, count, { hasImage: code => !!getKashrutImage(code) })
        : selectKashrutStamps(kashrut, count)
    if (!entries.length && imagesOnly) entries = selectKashrutStamps(kashrut, count)
    if (!entries.length) return null

    return <Flex gap={6} alignItems="center" wrap className={classNames(styles.stamps, className)}>
        {entries.map(e => <KashrutStamp key={`${e.stampCode}-${e.code}`} entry={e} />)}
    </Flex>
}

export default KashrutStamps
