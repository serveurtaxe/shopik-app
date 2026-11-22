import Address from 'pages/Account/Addresses/Address'
import styles from './windowOptions.module.css'
import Loader from 'common/components/Loader'
import WindowPicker from 'common/components/WindowPicker'
import useApi from 'common/functions/useApi'
import apiReq from 'common/functions/apiReq'
import { useEffect, useState } from 'react'
import { useOrder } from '../OrderProvider'
import { useAppData } from 'App'
import Flex from 'common/components/Flex'
import { useUser } from 'features/User'


export default function WindowOptions({ onChangeStore, onChangeAddress, hideAddress = false }) {
    const { order, setOrder } = useOrder()
    const { addresses } = useUser()
    const { pickupStores } = useAppData()
    const { data, loading, callReq, setData } = useApi('order/window/options')
    // Refetch windows when the order's store changes (e.g. after
    // delivery_method switches between pickup/delivery). The initial
    // useApi fetch runs on mount; this covers the race where options
    // would otherwise be fetched for the stale store.
    useEffect(() => { callReq() }, [order.storeId])

    const [windowLoading, setWindowLoading] = useState(null)
    const activeWindow = order?.window

    if (loading) return <Loader />

    const activeAddress = addresses?.find(a => a.active)
    const isPickup = order?.deliveryMethod === 'pickup'
    const selectedStore = isPickup ? pickupStores?.find(s => s.id === order.storeId) : null

    const onChoose = async (window) => {
        if (window.id === activeWindow?.id || window.disabled || windowLoading) return
        try {
            setWindowLoading(window.id)
            const updatedOrder = await apiReq('order/window/choose', { windowId: window.id })
            setOrder(updatedOrder)
            apiReq('order/window/options').then(setData).catch(() => {})
        } finally {
            setWindowLoading(null)
        }
    }

    return <Flex col gap={20} className={styles.windowOptions}>
        {!hideAddress && (onChangeStore && isPickup && selectedStore
            ? <Address store={selectedStore} action={{ text: 'change', onClick: onChangeStore }} />
            : <Address
                address={activeAddress}
                active={false}
                action={onChangeAddress ? { text: 'change', onClick: onChangeAddress } : undefined}
            />)}
        <WindowPicker
            days={data}
            activeWindowId={activeWindow?.id}
            loadingId={windowLoading}
            onSelect={onChoose}
        />
    </Flex>
}
