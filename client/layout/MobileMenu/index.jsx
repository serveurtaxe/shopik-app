import resolvePath from 'common/functions/resolvePath'
import openWhatsApp from 'common/functions/openWhatsApp'
import BackButton from 'common/components/BackButton'
import AuthPanel from 'features/User/AuthPanel'
import { useUser } from 'features/User'
import { getUserTitle, getUserSubtitle } from 'common/functions/userLabel'
import { INFO_LINKS } from 'layout/infoLinks'
import { useState, useEffect } from 'react'
import events from 'common/features/events'
import { useNavigate } from 'react-router'
import { useAppData } from 'App'
import styles from './mobileMenu.module.css'
import classNames from 'common/functions/classNames'
import Flex from 'common/components/Flex'
import Icon from 'common/components/Icon'
import Text from 'common/components/Text'

/**
 * Mobile drawer content (≤768px). Opens as a full menu list; tapping a
 * drill-in entry (login / departments) folds to the icon-rail + content
 * panel look. Tapping the active rail entry returns to the main list.
 */
export default function MobileMenu({ onClose }) {
    const { menu, settings } = useAppData() || {}
    const user = useUser()
    const [selected, setSelected] = useState(null)
    const navigate = useNavigate()

    // Guest pay opens the drawer on the login section (same event Header
    // uses to open the drawer). Ignored once logged in.
    useEffect(() => {
        const openLogin = () => {
            if (user?.id) return
            setSelected('login')
        }
        events.on('mobile-login', openLogin)
        return () => events.off('mobile-login', openLogin)
    }, [user?.id])

    const products = menu?.find(item => item.path === '/products')

    function go(path) {
        navigate(path)
        onClose?.()
    }

    const toggle = k => setSelected(s => s === k ? null : k)

    const handleWhatsApp = () => openWhatsApp(settings?.customerservice?.whatsappNumber, onClose)

    const railTop = [
        { key: 'login', icon: 'user', active: selected === 'login', onClick: () => toggle('login') },
        { key: 'departments', icon: 'grid', active: selected === 'departments', onClick: () => toggle('departments') },
        { key: 'sales', icon: 'salePercent', onClick: () => go('/sales') },
        { key: 'home', icon: 'home', onClick: () => go('/') },
    ]

    const railBottom = [
        { key: 'contact', icon: 'whatsapp', onClick: handleWhatsApp },
        ...INFO_LINKS.map(({ key, icon, path }) => ({ key, icon, onClick: () => go(path) })),
    ]

    const loginRow = { key: 'login', icon: 'user', text: getUserTitle(user), sub: getUserSubtitle(user), onClick: () => toggle('login') }

    const midRows = [
        { key: 'sales', icon: 'salePercent', text: 'Sales', bold: true, accent: true, onClick: () => go('/sales') },
        { key: 'departments', icon: 'grid', text: 'all_departments', bold: true, onClick: () => toggle('departments') },
        { key: 'home', icon: 'home', text: 'Home', bold: true, onClick: () => go('/') },
    ]

    const bottomRows = [
        { key: 'contact', icon: 'whatsapp', text: 'contact_us', onClick: handleWhatsApp },
        ...INFO_LINKS.map(({ key, text, icon, path }) => ({ key, text, icon, onClick: () => go(path) })),
    ]

    return <div className={styles.mobileMenu}>
        {selected ? (
            <div key={`rail-${selected}`} className={classNames(styles.view, styles.viewForward)}>
                <nav className={styles.rail} aria-label='menu'>
                    {railTop.map(row => <RailBtn
                        key={row.key}
                        entryKey={row.key}
                        icon={row.icon}
                        active={row.active}
                        onClick={row.onClick}
                    />)}
                    <span className={styles.divider} />
                    {railBottom.map(row => <RailBtn
                        key={row.key}
                        entryKey={row.key}
                        icon={row.icon}
                        active={row.active}
                        onClick={row.onClick}
                    />)}
                </nav>

                <div className={styles.panel}>
                    {selected === 'login' && <AuthPanel onClose={onClose} />}
                    {selected === 'departments' && (
                        products?.children?.length
                            ? <DeptBrowser items={products.children} basePath={products.path} go={go} />
                            : null
                    )}
                </div>
            </div>
        ) : (
            <div key='main-list' className={classNames(styles.view, styles.viewBack)}>
                <Flex tag='ul' col direction='column' gap={4} className={styles.mainList}>
                    <li key={loginRow.key}>
                        <button type='button' className={styles.mainRow} onClick={loginRow.onClick}>
                            <Icon name={loginRow.icon} className={styles.rowIcon} />
                            <span className={styles.rowTexts}>
                                <Text bold size='m'>{loginRow.text}</Text>
                                <Text size='s' mode='sub'>{loginRow.sub}</Text>
                            </span>
                            <Icon name='left' />
                        </button>
                    </li>
                    <li aria-hidden key='div-top' className={styles.divider} />
                    {midRows.map(row => <li key={row.key}>
                        <button type='button' className={row.accent ? styles.mainRowAccent : styles.mainRow} onClick={row.onClick}>
                            <Icon name={row.icon} className={styles.rowIcon} />
                            <Text bold={row.bold} size='l'>{row.text}</Text>
                        </button>
                    </li>)}
                    <li aria-hidden key='div-bottom' className={styles.divider} />
                    {bottomRows.map(row => <li key={row.key}>
                        <button type='button' className={styles.mainRow} onClick={row.onClick}>
                            <Icon name={row.icon} className={styles.rowIcon} />
                            <Text bold={row.bold} size='l'>{row.text}</Text>
                        </button>
                    </li>)}
                </Flex>
            </div>
        )}
    </div>
}

function RailBtn({ entryKey, icon, active, onClick }) {
    return <button
        type='button'
        aria-label={entryKey}
        onClick={onClick}
        className={classNames(styles.railBtn, [styles.active, active])}
    >
        <Icon name={icon} fallback />
    </button>
}

function DeptBrowser({ items, basePath, go }) {
    const [activePath, setActivePath] = useState(null)

    const active = activePath
        ? items.find(item => resolvePath(item, basePath) === activePath)
        : null

    // Sub-category view (groups + leaf links) with back to departments
    if (active) {
        return <Flex
            key={`groups-${activePath}`}
            tag='ul'
            col
            direction='column'
            gap={20}
            className={classNames(styles.groups, styles.viewForward)}
        >
            <li className={styles.backRow}>
                <BackButton onBack={() => setActivePath(null)}>{active.name}</BackButton>
            </li>
            {(active.children || []).map((group, i) => {
                const groupPath = resolvePath(group, activePath)
                return <li key={`${groupPath}-${i}`} className={styles.group}>
                    <Text bold size='l' className={styles.groupTitle}>{group.name}</Text>
                    {group.children?.length > 0 && (
                        <Flex tag='ul' col direction='column' gap={4}>
                            {group.children.map((child, j) => {
                                const childPath = resolvePath(child, groupPath)
                                return <li key={`${childPath}-${j}`}>
                                    <button
                                        type='button'
                                        className={styles.leafLink}
                                        onClick={() => go(childPath)}
                                    >
                                        <Text size='m'>{child.name}</Text>
                                    </button>
                                </li>
                            })}
                        </Flex>
                    )}
                </li>
            })}
        </Flex>
    }

    // Departments list (icon + name)
    return <Flex
        key='dept-list'
        tag='ul'
        col
        direction='column'
        gap={4}
        className={classNames(styles.deptList, styles.viewForward)}
    >
        {items.map((item, index) => {
            const hasChildren = Boolean(item.children?.length)
            const itemPath = resolvePath(item, basePath)
            return <li key={`${itemPath}-${index}`}>
                <button
                    type='button'
                    className={styles.deptItem}
                    onClick={() => (hasChildren ? setActivePath(itemPath) : go(itemPath))}
                >
                    <span className={styles.iconWrap}>
                        <Icon name={item.icon} fallback />
                    </span>
                    <Text size='l' className={styles.deptName}>{item.name}</Text>
                    {hasChildren && <Icon name='left' />}
                </button>
            </li>
        })}
    </Flex>
}
