import DeliveryView from 'features/Order/DeliveryView'
import UserView from 'features/User/UserView'
import MiniCart from 'layout/Cart/miniCart'
import Logo from 'common/components/Logo'
import { getSettingFileUrl } from 'common/functions/settingFileUrl'
import whatsappUrl from 'common/functions/whatsappUrl'
import styles from './header.module.css'
import MainMenu from 'layout/MainMenu'
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
    const navigate = useNavigate()
    const { settings } = useAppData()
    const { TR } = useText?.() || {}
    useEffect(() => {
        if (!drawerOpen) return
        const onKey = (e) => { if (e.key === 'Escape') setDrawerOpen(false) }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [drawerOpen])

    const handleWhatsAppClick = () => {
        const url = whatsappUrl(settings?.customerservice?.whatsappNumber)
        if (!url) return
        window.open(url, '_blank', 'noopener,noreferrer')
    }

    const infoMenuOptions = [
        {
            text: 'info_terms',
            onClick: () => navigate('/terms')
        },
        {
            text: 'info_privacy',
            onClick: () => navigate('/privacy')
        }
    ]

    return (
        <header className={styles.header}>
            <Button
                icon="menu"
                aria-label={TR?.('aria_menu')}
                aria-expanded={drawerOpen}
                className={styles.menuBtn}
                onClick={() => setDrawerOpen(v => !v)}
            />

            <div className={styles.logoWrap}>
                <Logo
                    src={getSettingFileUrl(settings?.appearance?.logo) || undefined}
                    darkSrc={getSettingFileUrl(settings?.appearance?.logoDark) || undefined}
                />
            </div>

            <div className={styles.userDelivery}>
                <UserView />
                <DeliveryView />
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

            <div className={classNames(styles.menuWrap, [styles.menuWrapOpen, drawerOpen])}>
                <MainMenu />
            </div>

            {drawerOpen && (
                <button
                    type="button"
                    aria-label={TR?.('aria_close_menu')}
                    className={styles.backdrop}
                    onClick={() => setDrawerOpen(false)}
                />
            )}
        </header>
    )
}
