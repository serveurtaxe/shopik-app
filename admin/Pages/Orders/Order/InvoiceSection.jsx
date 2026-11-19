import { useState } from 'react'
import apiReq from 'common/functions/apiReq'
import render from 'common/functions/render'
import { useText } from 'common/texts/TextProvider'
import Button from 'common/components/Button'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import InfoCard from 'components/Detail/InfoCard'
import styles from './order.module.css'

const coin = value => render({ type: 'coin', value })
const datetime = value => render({ type: 'datetime', value })

const STATUS_KEY = {
    issued: 'invoice_status_issued',
    failed: 'invoice_status_failed',
    pending: 'invoice_status_pending',
    pending_customer_details: 'invoice_status_pending_customer_details'
}

function Row({ label, value }) {
    return <Flex gap={8} alignItems='center' justifyContent='space-between'>
        <Text size='m' mode='sub'>{label}</Text>
        <Text size='m'>{value}</Text>
    </Flex>
}

/**
 * Invoice state for a single order.
 *
 * Everything shown here is read-only provider data (`Invoice`/`order.invoice`):
 * the numbers are never recalculated in the admin. The only action is a retry,
 * which asks EZcount again with the same idempotency key.
 */
export default function InvoiceSection({ order, onChanged }) {
    const { TR } = useText()
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState('')
    const invoice = order.invoice || {}
    const request = order.invoiceRequest || {}
    const credits = Array.isArray(invoice.credits) ? invoice.credits : []
    const breakdown = order.vatBreakdown || null
    const currency = value => (value == null ? null : coin(value))
    const statusKey = STATUS_KEY[invoice.status]
    const canRetry = order.paid && (invoice.status === 'failed' || invoice.status === 'pending_customer_details' || (!invoice.url && invoice.status !== 'issued'))
    const notPaid = !order.paid

    async function retry() {
        setBusy(true)
        setError('')
        try {
            await apiReq('payment/invoice_issue', { orderId: order.id })
            await onChanged?.()
        } catch (e) {
            setError(e?.message || 'invoice_failed')
        } finally {
            setBusy(false)
        }
    }

    return <InfoCard
        title={'invoice_details'}
        action={statusKey ? <Text size='m' bold className={styles.sumPill}>{statusKey}</Text> : null}
    >
        <Flex col gap={8}>
            {notPaid && !invoice.url && <Text size='m' mode='sub'>{'invoice_not_issued'}</Text>}

            {invoice.number && <Row label={'invoice_number'} value={invoice.number} />}
            {invoice.issuedAt && <Row label={'invoice_issued_at'} value={datetime(invoice.issuedAt)} />}
            {invoice.url && <Flex gap={8}>
                <Button mode='outline' icon='invoice' permission='invoice:read' onClick={() => window.open(invoice.url, '_blank', 'noopener')}>
                    invoice_open_doc
                </Button>
            </Flex>}

            {(request.taxId || request.companyName || request.email) && <Flex col gap={4}>
                {request.companyName && <Row label={'invoice_company_name'} value={request.companyName} />}
                {request.taxId && <Row label={'invoice_tax_id'} value={request.taxId} />}
                {request.email && <Row label={'invoice_sent_to'} value={request.email} />}
                {request.note && <Row label={'invoice_note'} value={request.note} />}
            </Flex>}

            {breakdown && (breakdown.net != null || breakdown.vat != null || breakdown.total != null) && <Flex col gap={4}>
                <Text size='m' bold>{'invoice_vat_breakdown'}</Text>
                {breakdown.net != null && <Row label={'invoice_net'} value={currency(breakdown.net)} />}
                {breakdown.vat != null && <Row label={'invoice_vat'} value={currency(breakdown.vat)} />}
                {breakdown.total != null && <Row label={'invoice_total'} value={currency(breakdown.total)} />}
            </Flex>}

            {invoice.error && <Text size='m' mode='error'>{invoice.error}</Text>}
            {invoice.creditError && <Text size='m' mode='error'>{TR('invoice_credit_failed')}: {invoice.creditError}</Text>}
            {order.billingAdjustment === 'pending' && <Text size='m' mode='error'>{'invoice_amount_changed'}</Text>}

            {canRetry && <Flex gap={8}>
                <Button mode='outline' permission='invoice:issue' loading={busy} onClick={retry}>
                    invoice_retry
                </Button>
            </Flex>}
            {error ? <Text size='m' mode='error'>{TR(error) || error}</Text> : null}

            {credits.length > 0 && <Flex col gap={6}>
                <Text size='m' bold>{'invoice_credits'}</Text>
                {credits.map((credit, i) => <Flex key={credit.invoiceId || i} gap={8} alignItems='center' justifyContent='space-between'>
                    <Flex gap={6} alignItems='center'>
                        <Text size='m'>{credit.number || '-'}</Text>
                        {credit.url ? <Button
                            mode='text-brand'
                            permission='invoice:read'
                            onClick={() => window.open(credit.url, '_blank', 'noopener')}
                        >invoice_open_doc</Button> : null}
                    </Flex>
                    <Text size='m' mode='sub'>{currency(credit.amount)}</Text>
                </Flex>)}
            </Flex>}
        </Flex>
    </InfoCard>
}
