import { buildWazeUrl, customerNotes, DeliveryMethodTag, formatDepartureTime, formatFullAddress, formatWindow, isShippingStatus, RemainingTime } from '../orderUtils'
import classNames from 'common/functions/classNames'
import TR from 'common/texts/TR.js'
import Button from 'common/components/Button'
import Loader from 'common/components/Loader'
import render from 'common/functions/render'
import useApi from 'common/functions/useApi'
import apiReq from 'common/functions/apiReq'
import styles from './opsOrder.module.css'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import Flex from 'common/components/Flex'
import { useNavigate, useParams } from 'react-router'
import { useUser } from 'features/User'
import { useState, useEffect } from 'react'
import Tabs from '#common/components/Tabs/index.jsx'
import ProductInline from 'common/components/ProductInline'
import Stepper from 'common/components/Stepper'
import { useModal } from 'common/components/Modal'
import ProductPickModal from './ProductPickModal'
import DeliverPhoto from './DeliverPhoto'
import { formatAmount } from 'common/components/Product'

const STEPS = {
    PREVIEW: 0,
    PICK: 1,
    PACK: 2,
    VIEW: 3,
    CONFIRM: 4,
    DELIVER: 5
}

const stepRenderer = [
    OrderPreview,
    OrderPick,
    OrderPack,
    OrderView,
    OrderConfirmBags,
    DeliverPhoto,
]

export default function OpsOrder({ }) {
    const [step, setStep] = useState(STEPS.PREVIEW)
    const StepComponent = stepRenderer[step] || null
    const { orderId } = useParams()
    const { error, loading, data = [], setData } = useApi(`order/ops/read`, { filter: { id: orderId } })
    const order = data[0] || {}
    const { id, isSuperAdmin } = useUser()
    const isMine = id == order.picker?.adminId,
        cantPick = !isMine && order.picker?.adminId,
        isShipMine = id == order.shipper?.adminId,
        cantShip = !isShipMine && order.shipper?.adminId
    const navigate = useNavigate()

    useEffect(() => {
        if (loading || !order?.status) return
        if (order.status === 'picked' && step === STEPS.PREVIEW) setStep(STEPS.PACK)
        else if (order.status === 'picking' && step === STEPS.PREVIEW && isMine) setStep(STEPS.PICK)
    }, [order.status, loading, isMine])


    if (loading) return <Loader />
    if (error) return <Text center mode='error'>{error.message}</Text>
    if (!order) return <Text center mode='error'>No order found</Text>
    async function claimOrder() {
        try {
            const res = await apiReq('order/ops/claim', { id: order.id })
            // apiReq returns the payload directly (throws on error):
            // server returns the updated order doc itself, not wrapped in data
            const newDoc = res?.cart ? res : res?.data || res
            if (newDoc?.id) setData([newDoc])
            setStep(STEPS.PICK)
        } catch (e) {
            alert(e.message || 'claim failed')
        }
    }
    function handlePicked(updatedOrder) {
        if (updatedOrder) {
            // server returns updated order doc directly, or wrapped in data
            const newDoc = updatedOrder.cart ? updatedOrder : updatedOrder.data || updatedOrder
            if (newDoc?.id) setData([newDoc])
            else setData(prev => prev)
        }
    }

    return <div className={styles.opsOrder}>
        <Flex gap={15} alignItems='center' className={styles.orderTitle}>
            <Button icon='back' mode='text' onClick={() => navigate('/ops')} />
            <Text size='h3' bold >{TR('ops_order_with_number', { number: order.number })}</Text>
        </Flex>
        {StepComponent ? <StepComponent
            order={order}
            claimOrder={claimOrder}
            isMine={isMine}
            cantPick={cantPick}
            isShipMine={isShipMine}
            cantShip={cantShip}
            isSuperAdmin={isSuperAdmin}
            setStep={setStep}
            goPreview={() => setStep(STEPS.PREVIEW)}
            onPicked={handlePicked}
        /> : null}
    </div>
}

function OrderPreview({ order = {}, claimOrder, isMine, cantPick, isShipMine, cantShip, isSuperAdmin, setStep }) {
    const windowTime = formatWindow(order.window)
    const notes = customerNotes(order)

    if (order.status === 'shipped') {
        return <PreviewShell
            order={order}
            windowTime={windowTime}
            bannerTitleKey='ops_delivery_title'
            bannerTime={formatDepartureTime(order.window)}
            bannerSubtitleKey='ops_departure_remaining'
            rows={<>
                <PriviewRow icon='user' label='customer_name' value={render({ type: 'name', value: order.name })} />
                <PriviewRow
                    icon='location'
                    label='customer_address'
                    value={formatFullAddress(order.address)}
                    actionIcon={(order.address?.location?.coordinates?.length || order.address?.street || order.address?.city) ? 'waze' : null}
                    actionTooltip='ops_navigate'
                    onAction={() => window.open(buildWazeUrl(order.address), '_blank', 'noopener')}
                />
                <PriviewRow icon='time' label='order_window' value={windowTime.textLong} />
                {notes && <PriviewRow icon='note' label='ops_customer_notes' value={notes} />}
                {order.shipperComment && <PriviewRow icon='note' label='ops_shipper_notes' value={order.shipperComment} />}
                {order.phone && <PriviewRow
                    icon='phone'
                    label='ops_customer_phone'
                    value={order.phone}
                    actionIcon='phoneOutgoing'
                    actionTooltip='ops_call'
                    onAction={() => { window.location.href = `tel:${String(order.phone).replace(/[^+\d]/g, '')}` }}
                />}
            </>}
            footer={<PreviewFooter
                primaryKey='ops_order_delivered'
                primaryDisabled={cantShip && !isSuperAdmin}
                onPrimary={() => setStep(STEPS.DELIVER)}
                linkKey='ops_view_order_only'
                onLink={() => setStep(STEPS.VIEW)}
            />}
        />
    }

    if (isShippingStatus(order.status)) {
        return <PreviewShell
            order={order}
            windowTime={windowTime}
            bannerTitleKey='ops_departure_title'
            bannerTime={formatDepartureTime(order.window)}
            bannerSubtitleKey='ops_departure_remaining'
            rows={<>
                <PriviewRow icon='user' label='customer_name' value={render({ type: 'name', value: order.name })} />
                <PriviewRow
                    icon='location'
                    label='customer_address'
                    value={formatFullAddress(order.address)}
                    actionIcon={(order.address?.location?.coordinates?.length || order.address?.street || order.address?.city) ? 'waze' : null}
                    actionTooltip='ops_navigate'
                    onAction={() => window.open(buildWazeUrl(order.address), '_blank', 'noopener')}
                />
                <PriviewRow icon='time' label='order_window' value={windowTime.textLong} />
                {notes && <PriviewRow icon='note' label='ops_customer_notes' value={notes} />}
                {order.shipperComment && <PriviewRow icon='note' label='ops_shipper_notes' value={order.shipperComment} />}
                {order.phone && <PriviewRow
                    icon='phone'
                    label='ops_customer_phone'
                    value={order.phone}
                    actionIcon='phoneOutgoing'
                    actionTooltip='ops_call'
                    onAction={() => { window.location.href = `tel:${String(order.phone).replace(/[^+\d]/g, '')}` }}
                />}
            </>}
            footer={<PreviewFooter
                primaryKey='ops_take_order'
                primaryDisabled={cantShip}
                onPrimary={isShipMine ? () => setStep(STEPS.VIEW) : () => setStep(STEPS.CONFIRM)}
                linkKey='ops_view_order_only'
                onLink={() => setStep(STEPS.VIEW)}
            />}
        />
    }

    return <PreviewShell
        order={order}
        windowTime={windowTime}
        bannerTitleKey='time_to_pick_title'
        bannerTime={`${order.window?.end}:00`}
        bannerSubtitleKey='time_to_pick_subtitle'
        rows={<>
            <PriviewRow icon='user' label='customer_name' value={order.phone || '0500000000'} />
            <PriviewRow icon='location' label='customer_address' value={render({ type: 'address', value: order.address })} />
            <PriviewRow icon='time' label='order_window' value={windowTime.textLong} />
            {/* <PriviewRow icon='replace' label='replace_and_missing' value={order.window?.replace} />
            <PriviewRow icon='note' label='pick_notes' value={order.comments} /> */}
        </>}
        footer={<PreviewFooter
            primaryKey='start picking'
            primaryDisabled={cantPick}
            onPrimary={isMine ? () => setStep(STEPS.PICK) : claimOrder}
            linkKey='view order'
            onLink={() => setStep(STEPS.VIEW)}
        />}
    />
}

function PreviewShell({ order = {}, windowTime = {}, bannerTitleKey, bannerTime, bannerSubtitleKey, rows, footer }) {
    const pills = []
    if (order.orderRestoredFrom) pills.push('ops_completion_order')
    if (order.userOrderNumber === 1) pills.push('ops_first_order')

    return <Flex col className={styles.orderPreview}>
        <Flex grow col gap={30}>
            <Flex alignItems='center' justifyContent='space-between' style={{ padding: 25, paddingBottom: 0, fontSize: 20 }}>
                <DeliveryMethodTag deliveryMethod={order.deliveryMethod} />
                <Text bold size='l'>{order.number}</Text>
            </Flex>
            {pills.length > 0 && <Flex gap={10} className={styles.pills}>
                {pills.map(key => <Flex key={key} center className={styles.pill}><Text size='s'>{key}</Text></Flex>)}
            </Flex>}
            <Flex gap={10} className={classNames(styles.intro, styles[windowTime.isLate ? 'danger' : windowTime.isAlmostLate ? 'warning' : 'success'])}>
                <Icon name='time' size={24} />
                <Flex col gap={10} grow>
                    <Flex alignItems='center' justifyContent='space-between' grow>
                        <Text size='h2' bold>{bannerTitleKey}</Text>
                        <Text size='h2' bold>{bannerTime}</Text>
                    </Flex>
                    <Flex gap={5}>
                        <Text size='m' className={styles.subtitle}>{bannerSubtitleKey}</Text>
                        <RemainingTime size='m' className={styles.subtitle} window={order.window} />
                    </Flex>
                </Flex>
            </Flex>
            <Flex col gap={25} className={styles.priviewRows}>
                {rows}
            </Flex>
        </Flex>
        {footer}
    </Flex>
}

function PreviewFooter({ primaryKey, primaryDisabled, onPrimary, linkKey, onLink }) {
    return <Flex center gap={20} col className={styles.footer}>
        <Button className={styles.startPickingBtn} disabled={primaryDisabled} onClick={onPrimary}>{primaryKey}</Button>
        <Button mode='text-brand' onClick={onLink}>{linkKey}</Button>
    </Flex>
}

function OrderView({ order = {}, setStep }) {
    const cart = order.cart || []

    return <Flex grow col className={styles.orderPick}>
        <Flex alignItems='center' justifyContent='center' style={{ padding: 16 }}>
            <Text size='l' bold>ops_view_title</Text>
        </Flex>
        <Flex grow col gap={10} className={styles.cartList}>
            {cart.map(product => (
                <ProductInline
                    key={product.id || product.barcode}
                    product={product}
                    remove={false}
                    note={false}
                    admin
                />
            ))}
        </Flex>
        <Flex center gap={20} className={styles.footer}>
            <Button mode='text-brand' onClick={() => setStep(STEPS.PREVIEW)}>back</Button>
        </Flex>
    </Flex>
}

function PriviewRow({ icon, label, value, actionIcon, actionTooltip, onAction }) {
    return <Flex gap={10} alignItems={value ? 'start' : 'center'} justifyContent='space-between' className={styles.priviewRow} onClick={onAction} style={onAction ? { cursor: 'pointer' } : undefined}>
        <Flex gap={10} alignItems={value ? 'start' : 'center'}>
            <Icon name={icon} size={24} />
            <Flex col gap={5} >
                <Text size='l' bold>{label}</Text>
                {value ? <Text >{value}</Text> : null}
            </Flex>
        </Flex>
        {actionIcon && <Button mode='text' icon={actionIcon} tooltip={actionTooltip} onClick={onAction} stopPropagation className={styles.rowAction} />}
    </Flex>
}

function OrderPick({ order = {}, setStep, onPicked }) {
    const [tab, setTab] = useState()
    const [completing, setCompleting] = useState(false)
    const { openModal, closeModal } = useModal()
    const cart = order.cart || []
    const isScanned = p => p.finalAmount != null || !!p.missing
    // group replaced originals with their replacer into one yellow linked card (image-3 style)
    const byBarcode = new Map(cart.map(p => [p.barcode, p]))
    const replacedPairs = []
    const pairedBarcodes = new Set()
    for (const p of cart) {
        const repBarcode = p.replacement?.replacementBarcode
        if (p.missing && repBarcode && byBarcode.has(repBarcode)) {
            replacedPairs.push({ original: p, replacer: byBarcode.get(repBarcode) })
            pairedBarcodes.add(p.barcode)
            pairedBarcodes.add(repBarcode)
        }
    }
    const toPickItems = cart.filter(p => !isScanned(p) && !pairedBarcodes.has(p.barcode))
    const donePickItems = cart.filter(p => isScanned(p) && !pairedBarcodes.has(p.barcode))
    const isDoneTab = tab === 'done_pick'
    const isWaitTab = tab === 'wait_pick'
    const displayed = isDoneTab ? donePickItems : isWaitTab ? [] : toPickItems
    const displayedPairs = isDoneTab ? replacedPairs : []
    const allHandled = toPickItems.length === 0 && cart.length > 0


    useEffect(() => {
        if (toPickItems.length === 0 && donePickItems.length > 0 && !isDoneTab) setTab('done_pick')
    }, [toPickItems.length, donePickItems.length])

    function handleProductClick(product) {
        openModal(
            <ProductPickModal product={product} orderId={order.id} onClose={() => closeModal()} onPicked={onPicked} />,
            { fullScreen: true, className: styles.pickModal }
        )
    }

    async function handleFinishPick() {
        if (!allHandled || completing) return
        setCompleting(true)
        try {
            const res = await apiReq('order/ops/pick_complete', { id: order.id })
            if (res?.error) {
                alert(res.error)
                return
            }
            const updated = res?.data || res
            if (updated?.id || updated?.cart) onPicked?.(updated)
            setStep(STEPS.PACK)
        } catch (e) {
            alert(e.message || 'pick_complete failed')
        } finally {
            setCompleting(false)
        }
    }

    return <Flex grow col className={styles.orderPick}>
        <Tabs
            className={styles.tabs}
            onChange={setTab}
            active={tab}
            mode='line'
            options={[
                { text: 'to_pick', badge: toPickItems.length },
                { text: 'wait_pick', badge: 0 },
                { text: 'done_pick', badge: donePickItems.length + replacedPairs.length },
            ]} />
        <Flex grow col gap={10} className={styles.cartList}>
            {displayedPairs.map(({ original, replacer }) => (
                <ReplacementCard
                    key={(original.id || original.barcode) + '->' + (replacer.id || replacer.barcode)}
                    original={original}
                    replacer={replacer}
                    onClick={() => handleProductClick(replacer)}
                />
            ))}
            {displayed.map(product => (
                <ProductInline
                    key={product.id || product.barcode}
                    product={product}
                    remove={false}
                    note={false}
                    admin
                    onClick={() => handleProductClick(product)}
                    style={{ cursor: 'pointer' }}
                />
            ))}
        </Flex>
        <Flex center gap={10} col className={styles.footer}>
            <Button disabled={!allHandled} loading={completing} onClick={handleFinishPick} className={styles.finishBtn}>finish_pick</Button>
            {toPickItems.length === 0 && order.phone && <Button
                mode='text-brand'
                icon='phoneOutgoing'
                onClick={() => { window.location.href = `tel:${String(order.phone).replace(/[^+\d]/g, '')}` }}
            >ops_call_customer</Button>}
        </Flex>
    </Flex>
}

function ReplacementCard({ original = {}, replacer = {}, onClick }) {
    return <Flex col gap={8} onClick={onClick} style={{ cursor: 'pointer' }} className={styles.replacedCard}>
        <Flex alignItems="center" gap={6}>
            <Icon name="replace" size={16} />
            <Text size="s" bold>ops_replaced</Text>
        </Flex>
        <Text size="xs" mode="sub">{TR('ops_replaced_original', { name: original.name || TR('ops_product_name_fallback'), amount: formatAmount(original, original.amount ?? 1) })}</Text>
        <ProductInline
            product={replacer}
            remove={false}
            note={false}
            admin
        />
    </Flex>
}

function OrderPack({ order = {}, onPicked }) {
    const navigate = useNavigate()
    const [loading, setLoading] = useState(false)
    const [packError, setPackError] = useState(null)
    const [regular, setRegular] = useState(order.bags?.regular ?? 0)
    const [cold, setCold] = useState(order.bags?.cold ?? 0)
    const [freeze, setFreeze] = useState(order.bags?.freeze ?? 0)

    async function handleTransfer() {
        if (loading) return
        setLoading(true)
        setPackError(null)
        try {
            const bags = {
                regular: Number(regular) || 0,
                cold: Number(cold) || 0,
                freeze: Number(freeze) || 0,
            }
            const res = await apiReq('order/ops/pack', { id: order.id, bags })
            const updated = res?.data || res
            if (updated?.id) onPicked?.(updated)
            navigate('/ops')
        } catch (e) {
            setPackError(e)
        } finally {
            setLoading(false)
        }
    }

    const chargeAmount = packError?.amount ?? order.finalSumWithShipping ?? order.sumWithShipping ?? order.finalSum ?? order.sum

    return <Flex grow col className={styles.orderPack}>
        <Flex col gap={6} className={styles.packInstruction}>
            <Text bold size="m">ops_pack_instruction</Text>
        </Flex>
        {packError ? <Flex col gap={8} className={styles.packError}>
            <Text bold size="m" mode="error">ops_pack_charge_failed</Text>
            <Text size="s" mode="error">{packError.message || TR('ops_payment_error')}</Text>
            {chargeAmount ? <Text size="s">{TR('ops_pack_charge_amount', { amount: chargeAmount })}</Text> : null}
            {packError.capturedTotal > 0 ? <Text size="s">{TR('ops_pack_charged', { total: packError.capturedTotal })}{packError.delta > 0 ? TR('ops_pack_remaining', { delta: packError.delta }) : null}</Text> : null}
            {order.payment?.last4digits ? <Text size="s">{TR('ops_pack_card', { last4: order.payment.last4digits })}</Text> : null}
            {packError.providerCode !== undefined ? <Text size="s">{TR('ops_pack_provider_code', { code: packError.providerCode })}</Text> : null}
            <Button mode="text-brand" onClick={handleTransfer}>ops_retry</Button>
        </Flex> : null}

        <Flex col gap={14} className={styles.packList}>
            <BagRow icon="box" labelKey="ops_bags_regular" value={regular} onChange={setRegular} />
            <BagRow icon="snow" labelKey="ops_bags_cold" value={cold} onChange={setCold} />
            <BagRow icon="bag" labelKey="ops_bags_other" value={freeze} onChange={setFreeze} />
        </Flex>

        <Flex center className={styles.footer}>
            <Button loading={loading} onClick={handleTransfer} className={styles.transferBtn}>ops_transfer_to_ship</Button>
        </Flex>
    </Flex>
}

function OrderConfirmBags({ order = {}, setStep }) {
    const navigate = useNavigate()
    const [loading, setLoading] = useState(false)
    const [touched, setTouched] = useState(false)
    const [regular, setRegular] = useState(0)
    const [cold, setCold] = useState(0)
    const [other, setOther] = useState(0)

    const expected = {
        regular: order.bags?.regular ?? 0,
        cold: order.bags?.cold ?? 0,
        other: order.bags?.freeze ?? order.bags?.extra ?? 0,
    }
    const match = regular === expected.regular && cold === expected.cold && other === expected.other
    const canAssign = touched && match

    function handleChange(setter) {
        return (v) => { setTouched(true); setter(v) }
    }

    async function handleAssign() {
        if (!canAssign || loading) return
        setLoading(true)
        try {
            const res = await apiReq('shipment/start', { orderIds: [order.id] })
            if (res?.failures?.length && !res?.successIds?.length) {
                alert(res.failures.join(', ') || 'shipment/start failed')
                setStep(STEPS.PREVIEW)
                return
            }
            navigate('/ops?asShipper=1')
        } catch (e) {
            alert(e.message || 'shipment/start failed')
            setStep(STEPS.PREVIEW)
        } finally {
            setLoading(false)
        }
    }

    return <Flex grow col className={styles.orderPack}>
        <Flex col gap={6} className={styles.packInstruction}>
            <Text bold size="m">ops_confirm_bags_title</Text>
        </Flex>

        <Flex col gap={14} className={styles.packList}>
            <BagRow icon="box" labelKey="ops_bags_regular" value={regular} onChange={handleChange(setRegular)} expected={expected.regular} />
            <BagRow icon="snow" labelKey="ops_bags_cold" value={cold} onChange={handleChange(setCold)} expected={expected.cold} />
            <BagRow icon="bag" labelKey="ops_bags_other" value={other} onChange={handleChange(setOther)} expected={expected.other} />
        </Flex>

        <Flex center gap={20} col className={styles.footer}>
            <Flex center className={styles.confirmErrorSlot}>
                {touched && !match && <Text size="s" mode="error" center>ops_bags_mismatch</Text>}
            </Flex>
            <Button loading={loading} disabled={!canAssign} onClick={handleAssign} className={styles.transferBtn}>ops_assign_to_me</Button>
            <Button mode='text-brand' onClick={() => setStep(STEPS.PREVIEW)}>back</Button>
        </Flex>
    </Flex>
}

function BagRow({ icon, labelKey, value, onChange, expected }) {
    return <Flex justifyContent="space-between" alignItems="center" className={styles.packRow}>
        <Flex gap={8} alignItems="center">
            <Icon name={icon} size={20} className={styles.packIcon} />
            <Text size="s">{labelKey}</Text>
        </Flex>
        <Flex gap={10} alignItems="center">
            {expected != null && <Flex gap={4} alignItems="center" className={styles.expected}>
                <Text size="s" mode="sub">ops_expected</Text>
                <Text size="s" bold>{expected}</Text>
            </Flex>}
            <Stepper value={value} onChange={onChange} />
        </Flex>
    </Flex>
}

