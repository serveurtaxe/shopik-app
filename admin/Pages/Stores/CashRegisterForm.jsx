import { useState, useEffect } from 'react'
import apiReq from 'common/functions/apiReq'
import useApi from 'common/functions/useApi'
import Input from 'common/components/Input'
import Flex from 'common/components/Flex'
import Loader from 'common/components/Loader'
import Form from 'common/components/Form'
import styles from './cashRegisterForm.module.css'

export default function CashRegisterForm({ storeId }) {
    const { data, loading, callReq } = useApi('cash_register/read', { filter: { storeId }, limit: 1 }, { hold: true })
    const existing = Array.isArray(data) ? data[0] : null
    const [key, setKey] = useState(0)

    useEffect(() => { callReq() }, [storeId])
    useEffect(() => { if (data !== undefined) setKey(k => k + 1) }, [existing?.id])

    async function handleSubmit(vals) {
        const payload = {
            storeId,
            active: vals.active === 'on' || vals.active === true || vals.active === 'true',
            data: {
                StockStoreID: vals.StockStoreID || undefined,
                OrderStoreID: vals.OrderStoreID || undefined,
                DeliveryCustomerID: vals.DeliveryCustomerID || undefined
            }
        }
        if (vals.active === undefined) payload.active = existing ? existing.active : true
        if (existing?.id) await apiReq('cash_register/update', { id: existing.id, ...payload })
        else await apiReq('cash_register/create', payload)
        callReq()
    }

    if (loading) return <Flex justifyContent='center' style={{ padding: 24 }}><Loader /></Flex>

    return <Flex col gap={16} style={{ minWidth: 360 }}>
        <Form key={key} className={styles.form} action={handleSubmit} submitText='שמור'>
            <Input name='StockStoreID' label='StockStoreID' defaultValue={existing?.data?.StockStoreID || ''} />
            <Input name='OrderStoreID' label='OrderStoreID' defaultValue={existing?.data?.OrderStoreID || ''} />
            <Input name='DeliveryCustomerID' label='DeliveryCustomerID' defaultValue={existing?.data?.DeliveryCustomerID || ''} />
            <Input name='active' label='פעיל' type='checkbox' defaultValue={existing ? existing.active : false} />
        </Form>
    </Flex>
}
