import OrderProvider from 'features/Order/OrderProvider'
import { ModalProvider } from 'common/components/Modal'
import TextProvider from 'common/texts/TextProvider'
import { createContext, useContext } from 'react'
import { Routes, Route, useLocation } from 'react-router'
import Lists from 'common/features/Lists'
import Header from 'layout/Header'
import User from 'features/User'
import Main from 'layout/Main'
import Footer from 'layout/Footer'
import CartProvider from 'layout/Cart/CartProvider'
import pages from './pages'
import styles from './App.module.css'

import 'common/styles/global.css'

const AppDataContext = createContext({})
export const useAppData = () => useContext(AppDataContext)

export default function App({ data = {} }) {
    const { pathname } = useLocation()
    const hideFooter = pathname === '/checkout' || pathname.startsWith('/checkout/')
    return <AppDataContext value={data}>
        <TextProvider>
            <Lists sdLists={data.lists}>
                <OrderProvider>
                    <User sdUser={data.user}>
                        <ModalProvider>
                            <CartProvider>
                                <div className={styles.app}>
                                    <Header />
                                    <Main>
                                        <Routes>
                                            {pages.map(({
                                                path, element: Elm
                                            }) => <Route key={path} path={path} element={<Elm />} />)}
                                        </Routes>
                                    </Main>
                                    {!hideFooter && <Footer />}
                                </div>
                            </CartProvider>
                        </ModalProvider>
                    </User>
                </OrderProvider>
            </Lists>
        </TextProvider>
    </AppDataContext>
}
