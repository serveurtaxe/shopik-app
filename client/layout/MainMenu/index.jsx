import classNames from 'common/functions/classNames'
import toSlug from 'common/functions/toSlug.js'
import resolvePath from 'common/functions/resolvePath'
import BackButton from 'common/components/BackButton'
import { useEffect, useRef, useState } from 'react'
import styles from './mainMenu.module.css'
import Flex from 'common/components/Flex'
import Icon from 'common/components/Icon'
import Text from 'common/components/Text'
import { NavLink, useLocation } from 'react-router'
import { useAppData } from 'App'
import { useCart } from 'layout/Cart/CartProvider'

export default function MainMenu({ openMenu: controlledOpen, onOpenMenu }) {
    const { menu } = useAppData() || {}
    const { cartOpen } = useCart()
    const [internalOpen, setInternalOpen] = useState(null)
    const openMenu = controlledOpen !== undefined ? controlledOpen : internalOpen
    const setOpenMenu = onOpenMenu || setInternalOpen
    const isControlled = controlledOpen !== undefined || onOpenMenu
    const menuRef = useRef(null)
    const location = useLocation()

    useEffect(() => {
        setOpenMenu(null)
    }, [location.pathname])

    useEffect(() => {
        if (isControlled) return
        const handlePointerDown = event => {
            if (!menuRef.current?.contains(event.target)) {
                setOpenMenu(null)
            }
        }

        document.addEventListener('pointerdown', handlePointerDown)

        return () => {
            document.removeEventListener('pointerdown', handlePointerDown)
        }
    }, [isControlled])

    const close = () => setOpenMenu(null)

    return <nav className={classNames(styles.mainMenu, [styles.shifted, cartOpen])}>
        <Flex ref={menuRef}
            tag='ul'
            alignItems='center'
            gap={15}
            className={styles.content}>
            {menu?.map((item, i) => {
                const itemKey = item.path || toSlug(item.name) || `main-item-${i}`
                return (
                    <MenuItem
                        key={itemKey}
                        {...item}
                        main
                        open={openMenu === itemKey}
                        onOpen={() => setOpenMenu(
                            openMenu === itemKey ? null : itemKey
                        )}
                        onClose={close}
                    />
                )
            })}
        </Flex>
    </nav>
}

function MenuItem({
    name,
    path,
    icon,
    children,
    main,
    open,
    onOpen,
    onClose,
}) {
    const hasChildren = Boolean(children && children.length > 0)
    const to = path

    if (main) {
        return (
            <li className={styles.mainListItem}>
                <Flex
                    className={styles.mainItem}
                    style={menuThemeVars(to)}
                    tag={hasChildren ? 'button' : NavLink}
                    to={hasChildren ? undefined : to}
                    type={hasChildren ? 'button' : undefined}
                    onClick={hasChildren ? onOpen : onClose}
                    end={hasChildren ? undefined : true}
                    alignItems='center'
                    gap={15}
                >
                    <Icon name={icon} fallback />
                    <Text bold size='l'>{name}</Text>
                    {hasChildren && <Icon name='down' />}
                </Flex>

                {hasChildren && (
                    <Level2Menu
                        items={children}
                        open={open}
                        basePath={path || (name ? toSlug(name) : '')}
                        onClose={onClose}
                    />
                )}
            </li>
        )
    }

    return null
}

function Level2Menu({ items, open, basePath, onClose }) {
    const [hoveredItem, setHoveredItem] = useState(null)
    const [activeItem, setActiveItem] = useState(null)

    // Reset hover and active states when the dropdown menu closes
    useEffect(() => {
        if (!open) {
            setHoveredItem(null)
            setActiveItem(null)
        }
    }, [open])

    const currentActiveItem = activeItem || hoveredItem

    const resolvedItems = items.map((item, index) => {
        const itemPath = resolvePath(item, basePath)
        return {
            item,
            itemPath,
            key: `${itemPath}-${index}`,
            hasChildren: Boolean(item.children && item.children.length > 0),
        }
    })

    const activeEntry = resolvedItems.find(
        entry => entry.hasChildren && entry.itemPath === currentActiveItem
    )

    return (
        <Flex
            tag='div'
            col
            direction='column'
            className={classNames(
                styles.level2Menu,
                [styles.level3visible, activeEntry],
                [styles.open, open]
            )}
            onMouseLeave={() => setHoveredItem(null)}
        >
            <Flex tag='ul' col gap={4} className={styles.level2Scroll}>
                {resolvedItems.map(({ item, itemPath, key, hasChildren }) => {
                    const isItemActive = currentActiveItem === itemPath

                    const handleItemClick = (e) => {
                        if (hasChildren) {
                            e.preventDefault()
                            setActiveItem(isItemActive ? null : itemPath)
                        } else {
                            onClose?.()
                        }
                    }

                    return (
                        <li
                            key={key}
                            className={styles.level2ListItem}
                            onMouseEnter={() => {
                                if (hasChildren) {
                                    setHoveredItem(itemPath)
                                }
                            }}
                        >
                            <Flex
                                className={classNames(
                                    styles.level2Item,
                                    [styles.active, isItemActive]
                                )}
                                tag={hasChildren ? 'button' : NavLink}
                                to={hasChildren ? undefined : itemPath}
                                type={hasChildren ? 'button' : undefined}
                                onClick={handleItemClick}
                                end={hasChildren ? undefined : true}
                                alignItems='center'
                                gap={12}
                            >
                                <div className={styles.iconWrap}>
                                    <Icon
                                        name={item.icon}
                                        fallback
                                    />
                                </div>

                                <Text size='l'>
                                    {item.name}
                                </Text>

                                {hasChildren && (
                                    <Icon name='left' />
                                )}
                            </Flex>
                        </li>
                    )
                })}
            </Flex>

            {activeEntry && (
                <Level3Menu
                    key={`level-3-${activeEntry.itemPath}`}
                    items={activeEntry.item.children}
                    visible
                    parentName={activeEntry.item.name}
                    basePath={activeEntry.itemPath}
                    onClose={onClose}
                    onBack={() => {
                        setActiveItem(null)
                        setHoveredItem(null)
                    }}
                />
            )}
        </Flex>
    )
}

function Level3Menu({ items, visible, parentName, basePath, onClose, onBack }) {
    return (
        <Flex
            tag='ul'
            className={classNames(
                styles.level3Menu,
                [styles.mobileLevel3Open, visible]
            )}
            gap={20}
            style={{ display: visible ? 'flex' : 'none' }}
        >
            <li className={styles.mobileClose}>
                <BackButton onBack={onBack}>{parentName}</BackButton>
            </li>

            {items.map((item, index) => {
                const itemPath = resolvePath(item, basePath)

                return (
                    <li
                        key={itemPath}
                        className={styles.level3Group}
                    >
                        <Text
                            bold
                            size='l'
                            className={styles.level3Title}
                        >
                            {item.name}
                        </Text>

                        {item.children?.length > 0 && (
                            <Flex
                                tag='ul'
                                col
                                direction='column'
                                gap={4}
                                className={styles.level4Menu}
                            >
                                {item.children.map((child, childIdx) => {
                                    const childPath = resolvePath(child, itemPath)

                                    return (
                                        <li key={`${childPath}-${childIdx}`}>
                                            <NavLink
                                                to={childPath}
                                                onClick={onClose}
                                                className={styles.level4Item}
                                            >
                                                <Text size='m'>
                                                    {child.name}
                                                </Text>
                                            </NavLink>
                                        </li>
                                    )
                                })}
                            </Flex>
                        )}
                    </li>
                )
            })}
        </Flex>
    )
}

// Theme vars for main pills come from Settings (category theme,
// subCategory colors) — entry-server injects them as :root vars.
// Falls back to .mainItem defaults when a setting is missing.
const MENU_THEME_KEYS = {
    '/products': 'departments',
    '/sales': 'sales',
    '/': 'home',
}

function menuThemeVars(path) {
    const key = MENU_THEME_KEYS[path]
    if (!key) return undefined
    return {
        '--main-bg': `var(--menu-${key}-bg, var(--bg-primary, #ffffff))`,
        '--main-border': `var(--menu-${key}-border, var(--border-secondary, #dde4e2))`,
        '--main-text': `var(--menu-${key}-text, var(--text-primary, #242a28))`,
    }
}