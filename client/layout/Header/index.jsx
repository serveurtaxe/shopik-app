import DeliveryView from 'features/Order/DeliveryView'
import UserView from 'features/User/UserView'
import MiniCart from 'layout/Cart/miniCart'
import Logo from 'common/components/Logo'
import { getSettingFileUrl } from 'common/functions/settingFileUrl'
import openWhatsApp from 'common/functions/openWhatsApp'
import styles from './header.module.css'
import MainMenu from 'layout/MainMenu'
import MobileMenu from 'layout/MobileMenu'
import Cart from 'layout/Cart'
import { INFO_LINKS } from 'layout/infoLinks'
import { closeAllPopovers, subscribePopoverCount } from 'common/components/Popover/registry'
import events from 'common/features/events'
import Search from 'layout/Search'
import Icon from 'common/components/Icon'
import Button from 'common/components/Button'
import ContextMenu from 'common/components/ContextMenu'
import classNames from 'common/functions/classNames'
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { useAppData } from 'App'
import { useText } from 'common/texts/TextProvider'

export default function Header() {
    const [drawerOpen, setDrawerOpen] = useState(false)
    const [openMenu, setOpenMenu] = useState(null)
    const [popCount, setPopCount] = useState(0)
    const navigate = useNavigate()
    const { settings } = useAppData()
    const { TR } = useText?.() || {}
    useEffect(() => {
        if (!drawerOpen && !openMenu) return
        const onKey = (e) => {
            if (e.key === 'Escape') {
                setDrawerOpen(false)
                setOpenMenu(null)
            }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [drawerOpen, openMenu])

    // A popover opening dismisses the categories menu so only one dim
    // layer is ever visible; opening the menu dismisses popovers.
    useEffect(() => {
        const onPopover = () => setOpenMenu(null)
        events.on('popover-opened', onPopover)
        return () => events.off('popover-opened', onPopover)
    }, [])

    useEffect(() => subscribePopoverCount(setPopCount), [])

    const handleWhatsAppClick = () => {
        openWhatsApp(settings?.customerservice?.whatsappNumber)
    }

    const infoMenuOptions = INFO_LINKS.map(({ text, icon, path }) => ({
        text,
        icon,
        onClick: () => navigate(path)
    }))

    return (
        <header className={styles.header}>
            <div className={styles.topBar}>
                <Button
                    icon="menu"
                    aria-label={TR?.('aria_menu')}
                    aria-expanded={drawerOpen}
                    className={styles.menuBtn}
                    onClick={() => setDrawerOpen(v => {
                        if (!v) document.querySelectorAll('dialog[open]').forEach(d => d.close())
                        return !v
                    })}
                />

                <div className={styles.logoWrap}>
                    <Logo
                        src={getSettingFileUrl(settings?.appearance?.logo) || undefined}
                        darkSrc={getSettingFileUrl(settings?.appearance?.logoDark) || undefined}
                        smallSrc={getSettingFileUrl(settings?.appearance?.logoSmall) || undefined}
                        smallDarkSrc={getSettingFileUrl(settings?.appearance?.logoSmallDark) || undefined}
                    />
                </div>

                {/* Lifted only while one of its popovers is open (not merely
                    when the drawer is closed), so the bar never covers the
                    open cart drawer on mobile. */}
                <div className={classNames(styles.userDelivery, [styles.liftAbove, popCount > 0])}>
                    <div className={styles.userViewWrap}>
                        <UserView />
                    </div>
                    <div className={styles.deliveryWrap}>
                        <DeliveryView />
                    </div>
                </div>

                <div className={styles.searchWrap}>
                    <Search />
                </div>

                <div className={styles.headerActions}>
                    <Button
                        icon="whatsapp"
                        className={styles.actionBtn}
                        onClick={handleWhatsAppClick}
                        aria-label={TR?.('aria_whatsapp')}
                        //tooltip="WhatsApp"
                        mode='text'
                    />

                    <ContextMenu
                        btnClassName={styles.contextMenuPopoverBtn}
                        modal={false}
                        // Same header-bottom line as the login/delivery popovers:
                        // 40px button centered in the ~56px row ends ~4-8px above
                        // the taller login button, so 14 ~= their 10.
                        topOffset={16}
                        button={
                            <Button
                                mode='text'
                                icon="info"
                                className={styles.actionBtn}
                                aria-label={TR?.('aria_info')}
                            //tooltip="מידע ותנאים"
                            />
                        }
                        options={infoMenuOptions}
                    />
                </div>

                <div className={styles.cartWrap}>
                    <MiniCart />
                </div>
            </div>

            <div className={classNames(styles.menuWrap, [styles.menuWrapOpen, drawerOpen], [styles.menuAbove, openMenu])}>
                <div className={styles.desktopMenu}>
                    <MainMenu openMenu={openMenu} onOpenMenu={(v) => {
                        if (v) closeAllPopovers()
                        setOpenMenu(v)
                    }} />
                </div>
                <MobileMenu onClose={() => setDrawerOpen(false)} />
            </div>

            {/* Cart drawer lives here (not in Main) so it slots into the
                header's stacking order: below overlay/popovers/top row,
                above the static menu row. Fixed positioning keeps it
                viewport-anchored; state lives in CartProvider. */}
            <Cart />

            {/* The single overlay: menu, drawer and popovers all share it.
                Plain header child (same stacking context, no portal):
                row-1 + open menu/drawer/dialogs lift above it (10002),
                cart drawer (9999) and everything else falls below it,
                and a press here only closes. */}
            {(openMenu || drawerOpen || popCount > 0) && (
                <div
                    aria-hidden
                    className={styles.menuOverlay}
                    onPointerDown={(e) => {
                        // Shield must stay mounted until the press ends: closing
                        // here would unmount it and let the following click land
                        // on the product underneath. preventDefault() suppresses
                        // the compatibility mouse/click sequence for this press.
                        e.preventDefault()
                        e.stopPropagation()
                    }}
                    onClick={(e) => {
                        e.stopPropagation()
                        setOpenMenu(null)
                        setDrawerOpen(false)
                        closeAllPopovers()
                    }}
                />
            )}
        </header>
    )
}
