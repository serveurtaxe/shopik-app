import OrderProvider from 'features/Order/OrderProvider'
import { ModalProvider } from 'common/components/Modal'
import TextProvider from 'common/texts/TextProvider'
import { createContext, useCallback, useContext, useEffect, useState, useRef } from 'react'
import { Routes, Route, useLocation } from 'react-router'
import apiReq from 'common/functions/apiReq'
import Lists from 'common/features/Lists'
import Header from 'layout/Header'
import User from 'features/User'
import Main from 'layout/Main'
import Footer from 'layout/Footer'
import CartProvider from 'layout/Cart/CartProvider'
import GlassixWidget from 'features/Glassix'
import VeeAccessibility from 'features/Vee'
import ProductOverlay from 'layout/ProductOverlay'
import pages from './pages'
import styles from './App.module.css'

import 'common/styles/global.css'

const AppDataContext = createContext({})
export const useAppData = () => useContext(AppDataContext)

export default function App({ data = {} }) {
    const location = useLocation()
    const { pathname } = location
    // A product link followed inside the app keeps the page it came from as the
    // "background" location: the URL becomes the real product URL while the
    // router keeps rendering the previous page and shows the product on top.
    const backgroundLocation = location.state?.backgroundLocation
    const hideFooter = pathname === '/checkout' || pathname.startsWith('/checkout/')
    const prevLocation = useRef(location)

    // The SSR payload is the client's only copy of the app data, so it lives in
    // state: the menu is store-scoped and has to be replaced in place when the
    // cart order moves to another store (see refreshMenu and OrderProvider).
    const [appData, setAppData] = useState(data)

    const refreshMenu = useCallback(async () => {
        try {
            const res = await apiReq('menu/get')
            // Keep the menu already on screen if the refetch fails: an empty
            // header is worse than a stale one, and the next page load fixes it.
            if (Array.isArray(res?.menu)) setAppData(prev => ({ ...prev, menu: res.menu }))
        } catch { }
    }, [])

    useEffect(() => {
        const wasOverlay = !!prevLocation.current.state?.backgroundLocation
        const isOverlay = !!backgroundLocation
        // Opening/closing the product overlay must leave the page behind it
        // exactly where it was, so only real navigations reset the scroll.
        if (!wasOverlay && !isOverlay) window.scrollTo(0, 0)
        prevLocation.current = location
    }, [pathname, location.key])

    return <AppDataContext value={{ ...appData, refreshMenu }}>
        <GlassixWidget />
        <VeeAccessibility />
        <TextProvider>
            <Lists sdLists={appData.lists}>
                <OrderProvider>
                    <User sdUser={appData.user}>
                        <ModalProvider>
                            <CartProvider>
                                <div className={styles.app}>
                                    <Header />
                                    <Main>
                                        <Routes location={backgroundLocation || location}>
                                            {pages.map(({
                                                path, element: Elm
                                            }) => <Route key={path} path={path} element={<Elm />} />)}
                                        </Routes>
                                    </Main>
                                    {!hideFooter && <Footer />}
                                    <ProductOverlay />
                                </div>
                            </CartProvider>
                        </ModalProvider>
                    </User>
                </OrderProvider>
            </Lists>
        </TextProvider>
    </AppDataContext>
}
