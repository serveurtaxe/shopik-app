import toSlug from 'common/functions/toSlug.js'
import whatsappUrl from 'common/functions/whatsappUrl'
import AuthPanel from 'features/User/AuthPanel'
import { useState } from 'react'
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
    const [selected, setSelected] = useState(null)
    const navigate = useNavigate()

    const products = menu?.find(item => item.path === '/products')

    function go(path) {
        navigate(path)
        onClose?.()
    }

    function openWhatsApp() {
        const url = whatsappUrl(settings?.customerservice?.whatsappNumber)
        if (!url) return
        window.open(url, '_blank', 'noopener,noreferrer')
        onClose?.()
    }

    return <div className={styles.mobileMenu}>
        {selected ? (
            <div key={`rail-${selected}`} className={classNames(styles.view, styles.viewForward)}>
                <nav className={styles.rail} aria-label='menu'>
                    <RailBtn
                        entryKey='login'
                        icon='user'
                        active={selected === 'login'}
                        onClick={() => (selected === 'login' ? setSelected(null) : setSelected('login'))}
                    />
                    <RailBtn
                        entryKey='departments'
                        icon='grid'
                        active={selected === 'departments'}
                        onClick={() => (selected === 'departments' ? setSelected(null) : setSelected('departments'))}
                    />
                    <RailBtn entryKey='sales' icon='salePercent' onClick={() => go('/sales')} />
                    <RailBtn entryKey='home' icon='home' onClick={() => go('/')} />
                    <span className={styles.railDivider} />
                    <RailBtn entryKey='contact' icon='whatsapp' onClick={openWhatsApp} />
                    <RailBtn entryKey='terms' icon='note' onClick={() => go('/terms')} />
                    <RailBtn entryKey='privacy' icon='shield' onClick={() => go('/privacy')} />
                </nav>

                <div className={styles.panel}>
                    {selected === 'login' && <AuthPanel onClose={onClose} />}
                    {selected === 'departments' && (
                        products?.children?.length
                            ? <DeptBrowser items={products.children} basePath={products.path} onClose={onClose} />
                            : null
                    )}
                </div>
            </div>
        ) : (
            <div key='main-list' className={classNames(styles.view, styles.viewBack)}>
                <Flex tag='ul' col direction='column' gap={4} className={styles.mainList}>
                    <li>
                        <button type='button' className={styles.mainRow} onClick={() => setSelected('login')}>
                            <Icon name='user' className={styles.rowIcon} />
                            <span className={styles.rowTexts}>
                                <Text bold size='l'>login_register_btn</Text>
                                <Text size='xs' mode='sub'>login_register_subTitle</Text>
                            </span>
                            <Icon name='left' />
                        </button>
                    </li>
                    <li aria-hidden className={styles.listDivider} />
                    <li>
                        <button type='button' className={styles.mainRowAccent} onClick={() => go('/sales')}>
                            <Text bold size='l'>Sales</Text>
                            <Icon name='salePercent' className={styles.rowIcon} />
                        </button>
                    </li>
                    <li>
                        <button type='button' className={styles.mainRow} onClick={() => setSelected('departments')}>
                            <Text bold size='l'>all_departments</Text>
                            <Icon name='grid' className={styles.rowIcon} />
                        </button>
                    </li>
                    <li>
                        <button type='button' className={styles.mainRow} onClick={() => go('/')}>
                            <Text bold size='l'>Home</Text>
                            <Icon name='home' className={styles.rowIcon} />
                        </button>
                    </li>
                    <li aria-hidden className={styles.listDivider} />
                    <li>
                        <button type='button' className={styles.mainRow} onClick={openWhatsApp}>
                            <Text size='l'>contact_us</Text>
                            <Icon name='whatsapp' className={styles.rowIcon} />
                        </button>
                    </li>
                    <li>
                        <button type='button' className={styles.mainRow} onClick={() => go('/terms')}>
                            <Text size='l'>info_terms</Text>
                            <Icon name='note' className={styles.rowIcon} />
                        </button>
                    </li>
                    <li>
                        <button type='button' className={styles.mainRow} onClick={() => go('/privacy')}>
                            <Text size='l'>info_privacy</Text>
                            <Icon name='shield' className={styles.rowIcon} />
                        </button>
                    </li>
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

function DeptBrowser({ items, basePath, onClose }) {
    const [activePath, setActivePath] = useState(null)
    const navigate = useNavigate()

    const active = activePath
        ? items.find(item => (item.path || `${basePath}/${toSlug(item.name)}`) === activePath)
        : null

    function go(path) {
        navigate(path)
        onClose?.()
    }

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
                <button type='button' onClick={() => setActivePath(null)}>
                    <Icon name='right' />
                    <Text bold size='l'>{active.name}</Text>
                </button>
            </li>
            {(active.children || []).map((group, i) => {
                const groupPath = group.path || `${activePath}/${toSlug(group.name)}`
                return <li key={`${groupPath}-${i}`} className={styles.group}>
                    <Text bold size='l' className={styles.groupTitle}>{group.name}</Text>
                    {group.children?.length > 0 && (
                        <Flex tag='ul' col direction='column' gap={4}>
                            {group.children.map((child, j) => {
                                const childPath = child.path || `${groupPath}/${toSlug(child.name)}`
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
            const itemPath = item.path || `${basePath}/${toSlug(item.name)}`
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
