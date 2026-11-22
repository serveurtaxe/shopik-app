import { useState } from 'react'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Button from 'common/components/Button'
import Popover from 'common/components/Popover'
import apiReq from 'common/functions/apiReq'
import render from 'common/functions/render'
import { getOrderSummary } from 'common/functions/orderSummary'
import { useText } from 'common/texts/TextProvider'
import InfoCard from 'components/Detail/InfoCard'
import styles from './order.module.css'

function SumRow({ label, value, bold, className }) {
    return <Flex justifyContent='space-between' gap={10} className={className}>
        <Text size='l' bold>{label}</Text>
        <Text size='l' bold={bold}>{value}</Text>
    </Flex>
}

export default function PaymentDetailsCard({ order, onChanged }) {
    const { TR } = useText()
    const coin = value => render({ type: 'coin', value })
    const [manualAmt, setManualAmt] = useState(0)
    const [manualBusy, setManualBusy] = useState(false)
    const [manualError, setManualError] = useState('')
    // Every row comes from the stored order (cart lines + coupons + shipping),
    // so the breakdown always adds up to the charged amount.
    const summary = getOrderSummary(order)
    const pending = summary.refundPending
    const payment = order.payment || {}
    // provider sends the expiry as YYMM
    const expiry = /^\d{4}$/.test(payment.cardExpiry || '')
        ? `${payment.cardExpiry.slice(2)}/${payment.cardExpiry.slice(0, 2)}`
        : payment.cardExpiry

    return <InfoCard title={'payment_details'}>
        <Flex col gap={16}>
            {payment.provider && <SumRow label={'payment_provider'} value={payment.provider} />}
            {payment.cardCompany && <SumRow label={'card_company'} value={payment.cardCompany} />}
            {payment.last4digits && <SumRow label={'card'} value={<bdi>****{payment.last4digits}</bdi>} />}
            {payment.payments > 1 && <SumRow label={'payments'} value={String(payment.payments)} />}
            {expiry && <SumRow label={'card_expiry'} value={expiry} />}
            {payment.captureProviderTxnId && <SumRow label={'transaction_id'} value={payment.captureProviderTxnId} />}
            {payment.capturedAt && <SumRow label={'captured_at'} value={render({ type: 'datetime', value: payment.capturedAt })} />}
        </Flex>
            <Flex col gap={16} className={styles.sumsSection}>
                <SumRow label={'items_count'} value={String(summary.itemsCount)} />
                {summary.hasSales && <SumRow label={'products_before_sales'} value={coin(summary.productsBeforeSales)} />}
                {summary.hasSales && <SumRow label={'sales_savings'} value={`-${coin(summary.saleSavings)}`} />}
                <SumRow label={'products_total'} value={coin(summary.productsAfterSales)} />
                {summary.coupons.map(coupon => <SumRow
                    key={coupon.code || coupon.amount}
                    label={`${TR('coupon_discount')} ${coupon.code || ''}`.trim()}
                    value={`-${coin(coupon.amount)}`}
                />)}
                {summary.hasCoupons && <SumRow label={'total_after_discounts'} value={coin(summary.afterDiscounts)} />}
                {summary.shipping > 0 && <SumRow label={'shipping_cost'} value={coin(summary.shipping)} />}
                <SumRow
                    label={'total_to_pay'}
                    value={coin(summary.charged)}
                    bold={!summary.hasRefunds}
                    className={summary.hasRefunds ? undefined : styles.totalRow}
                />
                {summary.hasRefunds && <SumRow label={'refunded'} value={coin(summary.refundedTotal)} />}
                {summary.hasRefunds && <SumRow label={'total_after_refunds'} value={coin(summary.netAfterRefunds)} bold className={styles.totalRow} />}
                {pending > 0 && <SumRow label={'refund_pending'} value={coin(pending)} />}
                {pending > 0 && !order.manualRequired && <Text size='s' mode='sub' style={{ lineHeight: '18px' }}>{'refund_auto_retry_note'}</Text>}
                {order.manualRequired && <Popover
                    button={<Button mode='outline' permission='order:payment'>register_manual_refund</Button>}
                >
                    {({ close }) => <Flex col gap={10} className={styles.cancelPopover}>
                        <Text size='s' mode='sub'>{'manual_refund_hint'}</Text>
                        <input
                            type='number' min={0} max={pending} step={0.01}
                            value={manualAmt}
                            onChange={e => setManualAmt(Number(e.target.value || 0))}
                            className={styles.amountInput}
                            aria-label='manual_refund_amount'
                        />
                        {manualError ? <Text size='s' mode='error'>{manualError}</Text> : null}
                        <Flex gap={8}>
                            <Button mode='outline' onClick={() => { setManualError(''); close() }}>cancel</Button>
                            <Button
                                loading={manualBusy}
                                disabled={!(manualAmt > 0) || manualAmt - pending > 0.001}
                                onClick={async () => {
                                    setManualBusy(true)
                                    setManualError('')
                                    try {
                                        await apiReq('payment/refund', { orderId: order.id, manual: true, amount: manualAmt })
                                        setManualAmt(0)
                                        close()
                                        await onChanged?.()
                                    } catch (e) {
                                        setManualError(e?.message || 'refund_failed')
                                    } finally {
                                        setManualBusy(false)
                                    }
                                }}
                            >manual_refund_confirm</Button>
                        </Flex>
                    </Flex>}
                </Popover>}
            </Flex>
    </InfoCard>
}
