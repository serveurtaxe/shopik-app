import { useState } from 'react'
import apiReq from 'common/functions/apiReq'
import AddressAutocomplete from 'common/components/AddressAutocomplete'
import Input from 'common/components/Input'
import Flex from 'common/components/Flex'
import Form from 'common/components/Form'
import { useModal } from 'common/components/Modal'

export default function AddressForm({ userId, initialData, onDone }) {
    const { closeModal } = useModal()
    const [formState, setFormState] = useState()
    const [autocomplete, setAutocomplete] = useState({
        city: initialData?.city || '',
        street: initialData?.street || '',
        building: initialData?.building || '',
        apartment: initialData?.apartment || ''
    })

    async function handleSubmit(data) {
        setFormState({ loading: true })
        // Validated autocomplete values win over raw inputs
        data.city = autocomplete.city || data.city
        data.street = autocomplete.street || data.street
        data.building = autocomplete.building || data.building
        data.apartment = autocomplete.apartment ?? data.apartment
        data.userId = userId

        const isEdit = !!initialData?.addressId
        if (isEdit) data.addressId = initialData.addressId
        const endpoint = isEdit ? 'user/address/admin_edit' : 'user/address/admin_add'

        try {
            await apiReq(endpoint, data)
            closeModal()
            await onDone?.()
        } catch (error) {
            setFormState({ error: error?.message || String(error), loading: false })
        }
    }

    return <Form action={handleSubmit} {...formState} submitText={initialData?.addressId ? 'address_update' : 'address_add'} autoComplete='off'>
        <input type='text' style={{ display: 'none' }} autoComplete='off' tabIndex={-1} aria-hidden='true' />
        <input type='password' style={{ display: 'none' }} autoComplete='off' tabIndex={-1} aria-hidden='true' />
        <AddressAutocomplete value={autocomplete} onChange={setAutocomplete} required />
        <Flex gap={16}>
            <Input name='floor' defaultValue={initialData?.floor} />
            <Input name='entrance' defaultValue={initialData?.entrance} />
        </Flex>
        <Input name='hasElevator' type='checkbox' defaultValue={initialData?.hasElevator ?? true} />
        <Input name='comment' type='textarea' rows={3} defaultValue={initialData?.comment} />
    </Form>
}
