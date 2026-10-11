import { AddressForm } from 'pages/Account/Addresses'
import Popover from 'common/components/Popover'
import Address from 'pages/Account/Addresses/Address'
import styles from './deliveryView.module.css'
import Button from 'common/components/Button'
import Title from '#common/components/Title'
import WindowOptions from '../WindowOptions'
import Flex from 'common/components/Flex'
import Loader from 'common/components/Loader'
import Tabs from 'common/components/Tabs'
import apiReq from '#common/functions/apiReq'
import events from 'common/features/events'
import { useUser } from 'features/User'
import { useEffect, useState } from 'react'
import { useAppData } from 'App'
import Icon from '#common/components/Icon/index.jsx'
import Text from '#common/components/Text/index.jsx'
import { useOrder } from '../OrderProvider'
import { useText } from '#common/texts/TextProvider.jsx'


const deliveryMethods = {
    delivery: { text: 'delivery', icon: 'truck' },
    pickup: { text: 'pickup', icon: 'bag' }
}

export default function DeliveryView({ }) {
    const
        { order = {}, setOrder } = useOrder(),
        { addresses = [], deliveryMethod: userMethod, onLogin } = useUser(),
        { pickupStores = [] } = useAppData(),
        [deliveryMethod, setDeliveryMethod] = useState(userMethod == deliveryMethods.pickup.text ?
            deliveryMethods.pickup.text : deliveryMethods.delivery.text),
        [popoverOpened, setPopoverOpened] = useState(false),
        [isSwitching, setIsSwitching] = useState(false),
        { icon, text } = deliveryMethods[deliveryMethod],
        { TR } = useText(),
        window = order?.window,
        isPickup = order?.deliveryMethod == deliveryMethods.pickup.text,
        windowDate = new Date(window?.date),
        buttonTitle = window?.id ? `${TR(`day-${windowDate.getDay()}-short`)} | ${window.start} - ${window.end}` : text,
        buttonSubTitle = (() => {
            const activeAddress = addresses.find(a => a.active)
            const selectedStore = isPickup ? pickupStores?.find(s => s.id === order.storeId) : null
            const addr = isPickup ? (selectedStore?.address ?? order.address) : activeAddress
            const label = addr?.city ? `${[addr.street, addr.building].filter(Boolean).join(' ')}, ${addr.city}` : null
            if (window?.id) return label ?? 'delivery_subTitle'
            if (isPickup) return label ?? 'delivery_subTitle'
            return 'delivery_subTitle'
        })()

    async function handleDeliveryMethodChange(value) {
        const wantsDelivery = value === deliveryMethods.delivery.text
        const needsSwitch = wantsDelivery && order?.deliveryMethod === 'pickup'
        if (needsSwitch) setIsSwitching(true)
        setDeliveryMethod(value)
        // When switching to delivery while order is in pickup, sync server so
        // Delivery tab shows windows for the active address, not the pickup store.
        // Keep switching state until the server confirms, so WindowOptions
        // does not fetch options for the stale pickup store.
        if (needsSwitch) {
            try {
                const res = await apiReq('user/delivery_method', {})
                if (res?.order) setOrder(res.order)
                if (res?.user || res?.order) onLogin(res)
            } catch (err) {
                console.error(err)
            } finally {
                setIsSwitching(false)
            }
        }
    }

    function openPopover() {
        setPopoverOpened(true)
    }

    useEffect(() => {
        events.on('delivery-popover', openPopover)
        return () => events.off('delivery-popover', openPopover)
    }, [])

    return <Popover
        id='delivery'
        topOffset={10}
        overlay modal={false} button={<Flex alignItems='center' gap={10} className={styles.button} onClick={openPopover}>
            <Icon name={icon} className={styles.icon} />
            <Flex alignItems='center' justifyContent='space-between' grow={1} className='btnTexts'>
                <Flex col gap={3}>
                    <Text bold size='m'>{buttonTitle}</Text>
                    <Text size='s'>{buttonSubTitle}</Text>
                </Flex>
                <Icon name='down' className={styles.chevron} />
            </Flex>
        </Flex>}>
        {() => <Flex col gap={25} className={styles.deliveryView}>
            {pickupStores.length ? <Tabs
                active={deliveryMethod}
                onChange={handleDeliveryMethodChange}
                options={Object.values(deliveryMethods)}
            /> : null}
            {isSwitching ? <Loader /> : deliveryMethod == deliveryMethods.delivery.text ?
                <Delivery open={popoverOpened} /> : <Pickup />}
        </Flex>}
    </Popover>
}

function Delivery({ open }) {
    const { addresses = [] } = useUser()
    const [isEditing, setIsEditing] = useState(false)
    const activeAddress = addresses.find(({ active }) => active)

    if (!addresses.length)
        return <AddressForm />

    if (isEditing) return <Flex col gap={15}>
        <Button mode="text" onClick={() => setIsEditing(false)}>cancel</Button>
        <Addresses onDone={() => setIsEditing(false)} />
    </Flex>

    if (activeAddress || addresses.length == 1) {
        return open
            ? <WindowOptions onChangeAddress={() => setIsEditing(true)} />
            : null
    }

    return <Addresses />
}

function Addresses({ onDone }) {
    const { addresses = [], onLogin } = useUser()
    const { setOrder } = useOrder()
    const [mode, setMode] = useState(null)
    const [editAddress, setEditAddress] = useState(null)

    async function select(address) {
        try {
            const res = await apiReq('user/address/active', { addressId: address.addressId })
            onLogin(res)
            if (res?.order) setOrder(res.order)
            onDone?.()
        } catch (err) {
            console.error(err)
        }
    }

    async function handleRemove(address) {
        try {
            const res = await apiReq('user/address/remove', { addressId: address.addressId })
            onLogin(res?.user ? res : { user: res })
            if (res?.order) setOrder(res.order)
        } catch (err) {
            console.error(err)
        }
    }

    function handleEdit(address) {
        setEditAddress(address)
        setMode('edit')
    }

    function handleAdd() {
        setEditAddress(null)
        setMode('add')
    }

    if (mode === 'add' || mode === 'edit') {
        return <Flex col gap={15}>
            <Button icon='back' mode='text-brand' text='back' onClick={() => setMode(null)} />
            <AddressForm initialData={editAddress} onDone={() => { setMode(null); setEditAddress(null) }} />
        </Flex>
    }

    return <Flex col gap={15}>
        {addresses.map(address => {
            const disabled = address.hasService === false
            return <Address key={address.addressId} address={address} onEdit={handleEdit} onRemove={handleRemove} action={{
                text: 'select',
                onClick: () => select(address),
                disabled
            }} />
        })}
        <Button onClick={handleAdd}>add-address</Button>
    </Flex>
}

function Pickup() {
    const { order = {} } = useOrder()
    const [isEditing, setIsEditing] = useState(false)
    const hasPickupStore = order?.deliveryMethod === 'pickup' && !!order.storeId

    useEffect(() => {
        if (!hasPickupStore) setIsEditing(false)
    }, [hasPickupStore])

    if (hasPickupStore && !isEditing) {
        return <WindowOptions onChangeStore={() => setIsEditing(true)} />
    }
    return <Flex col gap={15}>
        {hasPickupStore && (
            <Button mode="text" onClick={() => setIsEditing(false)}>cancel</Button>
        )}
        <StoreSelector onDone={() => setIsEditing(false)} />
    </Flex>
}


function StoreSelector({ onDone }) {
    const { pickupStores } = useAppData()
    const { onLogin, deliveryMethod: userMethod } = useUser()
    const { order = {}, setOrder } = useOrder()

    async function select(store) {
        try {
            const res = await apiReq('user/delivery_method', { pickupStoreId: store.id })
            if (res?.order) setOrder(res.order)
            if (res?.user || res?.order) onLogin(res)
            onDone?.()
        } catch (err) {
            console.error(err)
        }
    }

    return <Flex col gap={15}>
        <Title subtitle='select-store-subtitle'>select-store-title</Title>
        {pickupStores.map(store => <Address key={store.id} store={store}
            active={userMethod == 'pickup' && order.storeId === store.id}
            action={{
                text: 'select',
                onClick: () => select(store)
            }} />)}
    </Flex>
}   
