import styles from './logo.module.css'
import classNames from 'common/functions/classNames'
import { Link } from 'react-router'
import logo from './logo.svg'

export default function Logo({ className, noLink, src, darkSrc }) {
    const light = src || logo
    const _logo = darkSrc
        ? <picture><source srcSet={darkSrc} media="(prefers-color-scheme: dark)" /><img src={light} alt="logo" /></picture>
        : <img src={light} alt="logo" />

    return noLink ? _logo : <Link to='/' className={classNames(styles.logo, className)}>
        {_logo}
    </Link>
}
