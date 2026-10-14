import styles from './logo.module.css'
import classNames from 'common/functions/classNames'
import { Link } from 'react-router'
import logo from './logo.svg'

export default function Logo({ className, noLink, src, darkSrc, smallSrc, smallDarkSrc }) {
    const light = src || logo
    const pic = (imgSrc, dark) => dark
        ? <picture><source srcSet={dark} media="(prefers-color-scheme: dark)" /><img src={imgSrc} alt="logo" /></picture>
        : <img src={imgSrc} alt="logo" />
    const _logo = pic(light, darkSrc)
    const _small = smallSrc ? pic(smallSrc, smallDarkSrc) : null

    const content = _small
        ? <>
            <span className={styles.full}>{_logo}</span>
            <span className={styles.small}>{_small}</span>
        </>
        : _logo

    return noLink ? content : <Link to='/' className={classNames(styles.logo, className)}>
        {content}
    </Link>
}
