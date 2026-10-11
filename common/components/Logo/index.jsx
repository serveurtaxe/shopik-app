import styles from './logo.module.css'
import classNames from 'common/functions/classNames'
import { Link } from 'react-router'
import logo from './logo.svg'

export default function Logo({ className, noLink, src, darkSrc, smallSrc, smallDarkSrc }) {
    const light = src || logo
    const _logo = darkSrc
        ? <picture><source srcSet={darkSrc} media="(prefers-color-scheme: dark)" /><img src={light} alt="logo" /></picture>
        : <img src={light} alt="logo" />
    const _small = smallSrc
        ? (smallDarkSrc
            ? <picture><source srcSet={smallDarkSrc} media="(prefers-color-scheme: dark)" /><img src={smallSrc} alt="logo" /></picture>
            : <img src={smallSrc} alt="logo" />)
        : null

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
