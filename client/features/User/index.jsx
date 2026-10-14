import { createContext, useContext, useState } from 'react'
import apiReq from '#common/functions/apiReq.js'
import { useOrder } from '../Order/OrderProvider'

const UserContext = createContext({})
export const useUser = () => useContext(UserContext)

export default function User({ children, sdUser = {} }) {
    const [user, setUser] = useState(sdUser)
    const { setOrder, queueCartSync } = useOrder()

    async function logout() {
        await apiReq('user/logout')
        setUser({})
        setOrder(null)
    }

    function onLogin({ user, order }) {
        if (user?.id) {
            setUser(user)
            // Server wins: replay the device cart only when the server order
            // is empty (covers device carts orphaned without a guest cookie,
            // which the server-side guest merge can't see). Read before
            // removeItem; sync failures keep the previous state.
            if (!order?.cart?.length) {
                try {
                    const parsed = JSON.parse(localStorage.cart || 'null')
                    if (Array.isArray(parsed)) {
                        for (const item of parsed) {
                            const amount = Number(item?.amount) || 0
                            if (item?.id && amount > 0) queueCartSync(item, amount)
                        }
                    }
                } catch { }
            }
            localStorage.removeItem('cart')
        }
        if (order)
            setOrder(order)
    }

    async function userEdit(newData) {
        const res = await apiReq('user/edit', newData)
        setUser({ ...user, ...res.user })
        return res
    }

    async function addressEdit(newData) {
        const res = await apiReq('user/address/edit', newData)
        setUser({ ...user, ...res.user })
        return true
    }

    return <UserContext.Provider value={{ ...user, setUser, onLogin, logout, userEdit, addressEdit }} >
        {children}
    </UserContext.Provider >

}