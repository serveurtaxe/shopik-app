import { useState } from 'react'
import { useParams } from 'react-router'
import useApi from 'common/functions/useApi'
import { useText } from 'common/texts/TextProvider'
import Loader from 'common/components/Loader'
import Text from 'common/components/Text'
import Flex from 'common/components/Flex'
import DetailPage from 'components/Detail/DetailPage'
import OrderStatusSection from './OrderStatusSection'
import OrderActions from './OrderActions'
import RefundSection from './RefundSection'
import RefundsSection from './RefundsSection'
import InvoiceSection from './InvoiceSection'
import ProductsSection from './ProductsSection'
import OrderDetailsCard from './OrderDetailsCard'
import PaymentDetailsCard from './PaymentDetailsCard'
import styles from './order.module.css'

const dateFormatter = new Intl.DateTimeFormat('he', { day: 'numeric', month: 'long', year: 'numeric' })
const timeFormatter = new Intl.DateTimeFormat('he', { hour: '2-digit', minute: '2-digit', hour12: false })

const formatPaidAt = value => {
    const date = new Date(value)
    return `${dateFormatter.format(date)} | ${timeFormatter.format(date)}`
}

export default function Order() {
    const { orderId } = useParams()
    const { TR } = useText()
    const [refundMode, setRefundMode] = useState(false)
    const detailsApi = useApi('order/details', { id: orderId })
    const { data: order, loading, error } = detailsApi

    if (loading && !order) return <Loader />
    if (error && !order) return <Text center mode='error'>{error.message}</Text>
    if (!order) return <Text center mode='error'>{'order_not_found'}</Text>

    const refresh = async () => { await detailsApi.callReq() }

    return <DetailPage
        backFallback='/orders'
        title={<Text size='h2' bold>#{order.number}</Text>}
        labels={order.labels || []}
        meta={order.paidAt && <Flex gap={6} alignItems='center' className={styles.payDate}>
            <Text size='m'>{`${formatPaidAt(order.paidAt)}`}</Text>
        </Flex>}
        actions={<OrderActions
            order={order}
            refundMode={refundMode}
            onToggleRefund={() => setRefundMode(m => !m)}
            onChanged={refresh}
        />}
        sidebar={<>
            <OrderDetailsCard order={order} />
            <PaymentDetailsCard order={order} onChanged={refresh} />
            <InvoiceSection order={order} onChanged={refresh} />
        </>}
    >
        <OrderStatusSection order={order} />
        {refundMode
            ? <RefundSection order={order} onDone={async () => { await refresh(); setRefundMode(false) }} onExit={() => setRefundMode(false)} />
            : <ProductsSection order={order} />}
        {Number(order.refundedTotal || 0) > 0 && <RefundsSection order={order} />}
    </DetailPage>
}
