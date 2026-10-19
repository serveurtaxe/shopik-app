import Button from 'common/components/Button'
import apiReq from 'common/functions/apiReq'
import styles from './addresses.module.css'
import Input from 'common/components/Input'
import Text from 'common/components/Text'
import Flex from 'common/components/Flex'
import Form from 'common/components/Form'
import { useUser } from 'features/User'
import { useState } from 'react'
import Address from './Address'
import Title from '#common/components/Title/index.jsx'
import { useOrder } from 'features/Order/OrderProvider'
import AddressAutocomplete from 'common/components/AddressAutocomplete'

export function AddressForm({ initialData, onDone, cityRef }) {
    const [formState, setFormState] = useState()
    const { onLogin } = useUser()
    const { setOrder } = useOrder()
    const [autocomplete, setAutocomplete] = useState({
        city: initialData?.city || '',
        street: initialData?.street || '',
        building: initialData?.building || '',
        apartment: initialData?.apartment || ''
    })

    function handleSubmit(data) {
        setFormState({ loading: true })

        const isEdit = !!initialData?.addressId
        if (isEdit) {
            data.addressId = initialData.addressId
        }
        // Merge validated autocomplete values (real addresses)
        data.city = autocomplete.city || data.city
        data.street = autocomplete.street || data.street
        data.building = autocomplete.building || data.building
        data.apartment = autocomplete.apartment ?? data.apartment
        const endpoint = isEdit ? 'user/address/edit' : 'user/address/add'

        apiReq(endpoint, data)
            .then(res => {
                onLogin(res?.user ? res : { user: res })
                if (res?.order) {
                    setOrder(res.order)
                }
                onDone?.()
            })
            .catch(error => {
                setFormState({ error: error?.message || String(error), loading: false })
            })
    }

    return (
        <Form action={handleSubmit} {...formState} submitText={initialData?.addressId ? 'address_update' : 'address_add'} autoComplete="off">
            <input type="text" style={{ display: 'none' }} autoComplete="off" tabIndex={-1} aria-hidden="true" />
            <input type="password" style={{ display: 'none' }} autoComplete="off" tabIndex={-1} aria-hidden="true" />
            <AddressAutocomplete value={autocomplete} onChange={setAutocomplete} required cityRef={cityRef} />
            <Flex gap={16}>
                <Input name='floor' defaultValue={initialData?.floor} />
                <Input name='entrance' defaultValue={initialData?.entrance} />
            </Flex>
            <Input name='comment' placeholder={'address.comment'} type='textarea' rows={3} defaultValue={initialData?.notes} />
        </Form>
    )
}

export default function Addresses({ action, hideHeader, blinkNoService = false }) {
    const user = useUser()
    const [mode, setMode] = useState(action ? 'select' : 'browse')
    const [editAddress, setEditAddress] = useState(null)

    function handleAdd() {
        setMode('add')
        setEditAddress(null)
    }

    function handleEdit(address) {
        setMode('edit')
        setEditAddress(address)
    }

    async function setActive({ addressId }) {
        try {
            const res = await apiReq('user/address/active', { addressId })
            user.onLogin(res?.user ? res : { user: res })
        } catch (err) {
            console.error(err)
        }
    }

    async function handleRemove(address) {
        try {
            const res = await apiReq('user/address/remove', { addressId: address.addressId })
            user.onLogin(res?.user ? res : { user: res })
        } catch (err) {
            console.error(err)
        }
    }

    const addresses = user?.addresses || []
    if (['add', 'edit'].includes(mode))
        return <Flex col gap={16}>
            <Button icon='back' onClick={() => setMode(action ? 'select' : 'browse')} mode='text-brand' text='back' />
            <Title center={false} subtitle={mode == 'edit' ? 'edit-address-subtitle' : 'add-address-subtitle'}>{mode == 'edit' ? 'edit-address-title' : 'add-address-title'}</Title>
            <AddressForm initialData={editAddress} onDone={() => setMode(action ? 'select' : 'browse')} />
        </Flex>

    return (
        <Flex col gap={24}>
            {!hideHeader && <Title subtitle={'addresses-subtitle'}>addresses</Title>}

            {addresses.length === 0 ? (
                <Text>no addresses yet</Text>
            ) : (
                <Flex col gap={16}>
                    {addresses.map((address) => <Address
                        key={address.addressId}
                        address={address}
                        blink={blinkNoService && address.hasService === false}
                        onEdit={handleEdit}
                        onRemove={handleRemove}
                        action={{ onClick: () => setActive(address), text: 'setActive', disabled: address.hasService === false }}
                    />)}
                </Flex>
            )}

            <Button onClick={handleAdd} >add address</Button>
        </Flex>
    )
}
