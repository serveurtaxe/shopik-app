import classNames from 'common/functions/classNames'
import { useLists } from 'common/features/Lists'
import { useNavigate } from 'react-router'
import Flex from 'common/components/Flex'
import Icon from 'common/components/Icon'
import Text from 'common/components/Text'
import { useUser } from 'features/User'
import styles from './ops.module.css'
import { DeliveryMethodTag, formatDepartureTime, formatWindow, isClosedOrder, isDeliveryCard, opsStatusKey, RemainingTime, orderCardTone, shortNumber } from './orderUtils'
import render from '#common/functions/render.js'
import ProgressGauge from '#common/components/ProgressGauge/index.jsx'

export default function OrderCard({ order = {} }) {
    const
        { deliveryMethod, status, storeId, cart, bags = {}, cartCount, handledCount } = order,
        windowTime = formatWindow(order.window),
        tone = orderCardTone(order),
        isDelivery = isDeliveryCard(status),
        isClosed = isClosedOrder(status),
        { stores } = useLists(),
        store = stores.find(s => s.value == storeId),
        address = deliveryMethod == 'pickup' ? store?.address : order.address,
        navigate = useNavigate(),
        // The queue ships the two counts directly; a full cart (a detail row, or an
        // older server) is still derived the same way.
        total = cartCount ?? (cart || []).length,
        handled = handledCount ?? (cart || []).filter(p => p.finalAmount != null || !!p.missing).length,
        regularCount = bags.regular ?? 0,
        coldCount = bags.cold ?? 0,
        otherCount = bags.freeze ?? bags.extra ?? 0,
        departureTime = formatDepartureTime(order.window),
        bottomName = order.shipper?.name || order.picker?.name,
        routeSeq = order._route?.seq,
        me = useUser()?.id,
        // Prefer the server's isMine; fall back to a client check so a stale list
        // (claim happened after the page loaded) still marks the card as ours.
        isMine = order.isMine ?? (order.picker?.adminId == me),
        // Own while it is still open reads as "mine"; a closed order is just what
        // it ended as.
        statusKey = isMine && !isClosed
            ? (isDelivery ? 'ops_shipped_mine' : 'ops_pick_mine')
            : opsStatusKey(status)

    function onOrderCardClick() {
        navigate(`/ops-order/${order.id}`)
    }

    return <Flex col onClick={onOrderCardClick} className={classNames(
        styles.orderCard,
        [styles.danger, tone == 'danger'],
        [styles.warning, tone == 'warning'],
        [styles.success, tone == 'success'],
        [styles.mine, isMine]
    )}>
        <Flex className={styles.row} alignItems='center' justifyContent='space-between'>
            <Flex gap={5} alignItems='center' >
                <DeliveryMethodTag deliveryMethod={order.deliveryMethod} />
                <Text bold>|</Text>
                <Text bold>{shortNumber(order.number)}</Text>
                {routeSeq != null && <Text bold size='s'>#{routeSeq + 1}</Text>}
            </Flex>
            <Text size='s'>{render({ type: 'name', value: order.name })}</Text>
        </Flex>
        <Flex className={styles.row} alignItems='center' justifyContent='space-between' >
            <Flex gap={5} alignItems='center' >
                <Icon name='stores' />
                <Text size='s'>{store?.text}</Text>
            </Flex>
            <Flex gap={5} alignItems='center' >
                <Icon name='location' />
                <Text size='s'>{address?.street} {address?.building}, {address?.city}</Text>
            </Flex>
            <Flex gap={5} alignItems='center' >
                <Icon name='time' />
                <Text size='s'>{windowTime.dayText}</Text>
            </Flex>
        </Flex>
        {isDelivery ? <Flex className={styles.row} justifyContent='space-between'>
            <Flex gap={15} center>
                <Flex gap={5} alignItems='center'>
                    <Text bold size='xl'>{regularCount}</Text>
                    <Icon name='box' />
                </Flex>
                <Flex gap={5} alignItems='center'>
                    <Text bold size='xl'>{coldCount}</Text>
                    <Icon name='snow' />
                </Flex>
                <Flex gap={5} alignItems='center'>
                    <Text bold size='xl'>{otherCount}</Text>
                    <Icon name='bag' />
                </Flex>
            </Flex>
            <Flex col gap={5} center>
                <Text size='s' mode='sub'>ops_departure_time</Text>
                <Text bold size='xl'>{departureTime}</Text>
            </Flex>
        </Flex> : <Flex className={styles.row} justifyContent='space-between'>
            <Flex gap={20} center>
                <ProgressGauge value={total ? (handled / total) * 100 : 0} />
                <Flex col gap={5}>
                    <Text bold size='xl'>{handled}/{total}</Text>
                    <Text size='s' mode='sub'>ops_handled_products</Text>
                </Flex>
            </Flex>
            <Flex col gap={5} center>
                <RemainingTime bold size='xl' window={order.window} />
                <Text size='s' mode='sub'>ops_pick_end</Text>
            </Flex>
        </Flex>}
        <Flex className={styles.row} alignItems='center' justifyContent='space-between'>
            <Flex gap={5} alignItems='center' >
                <Icon name='checkEmpty' />
                <Text bold>{statusKey}</Text>
            </Flex>
            {bottomName && <Text size='s'>{bottomName}</Text>}
        </Flex>
    </Flex>
}
