import { createContext, useContext, useEffect, useState } from 'react'
import { useLocation } from 'react-router'

const CartUIContext = createContext({})

export const useCart = () => useContext(CartUIContext)

export default function CartProvider({ children }) {
    const [cartOpen, setCartOpen] = useState(false)
    const location = useLocation()

    // Close the cart whenever the route changes
    useEffect(() => {
        setCartOpen(false)
    }, [location.pathname])

    const toggleCart = () => setCartOpen(prev => !prev)

    return <CartUIContext value={{ cartOpen, setCartOpen, toggleCart }}>
        {children}
    </CartUIContext>
}
