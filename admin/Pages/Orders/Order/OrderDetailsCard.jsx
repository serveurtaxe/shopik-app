import { useNavigate } from 'react-router'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import { useText } from 'common/texts/TextProvider'
import { DeliveryMethodTag, formatFullAddress, formatWindow } from 'Pages/Ops/orderUtils'
import InfoCard, { InfoRow } from 'components/Detail/InfoCard'

export default function OrderDetailsCard({ order }) {
    const navigate = useNavigate()
    const { TR } = useText()
    const windowTime = formatWindow(order.window)
    const fullName = `${order.name?.first || ''} ${order.name?.last || ''}`.trim()
    const nameLabel = fullName || TR('customer_page_link')
    const nameNode = order.userId
        ? <Text size='l' bold underline style={{ cursor: 'pointer' }} onClick={() => navigate(`/users/${order.userId}`)}>{nameLabel}</Text>
        : nameLabel

    return <InfoCard title={'order_details_title'}>
        {(fullName || order.userId) && <InfoRow icon='person' label={nameNode}>
            <Text size='m' mode='sub'>{order.phone}</Text>
            {order.secondPhone && <Text size='m' mode='sub'>{order.secondPhone}</Text>}
            {order.email && <Flex gap={5} alignItems='center'>
                <Icon name='mail' size={14} />
                <Text size='m' mode='sub'>{order.email}</Text>
            </Flex>}
        </InfoRow>}
        {order.address && <InfoRow icon='location' label='customer_address'>
            <Text size='m'>{formatFullAddress(order.address)}</Text>
            {order.deliveryMethod !== 'pickup' && <Text size='m' mode='sub'>
                {TR('address.hasElevator')}: {TR(order.address.hasElevator === false ? 'elevator_no' : 'elevator_yes')}
            </Text>}
            {order.address.comment && <Text size='m' mode='sub'>{order.address.comment}</Text>}
        </InfoRow>}
        <InfoRow icon='time' label='order_window'>
            <Text size='m'>{windowTime.dayText}</Text>
            <DeliveryMethodTag deliveryMethod={order.deliveryMethod} />
        </InfoRow>
        {(order.replaceProducts || order.replaceProductsNoCall || order.leaveOrderAtDoor) && <InfoRow icon='replace' label='replace_and_missing'>
            {order.replaceProducts && <Text size='m'>{'replace_products'}</Text>}
            {order.replaceProductsNoCall && <Text size='m'>{'replace_no_call'}</Text>}
            {order.leaveOrderAtDoor && <Text size='m'>{'leave_at_door'}</Text>}
        </InfoRow>}
        {order.comment && <InfoRow icon='note' label='order_comment'>
            <Text size='m'>{order.comment}</Text>
        </InfoRow>}
        {order.picker?.name && <InfoRow icon='user' label='picked_by'>
            <Text size='m'>{order.picker.name}</Text>
        </InfoRow>}
        {order.pickFinalizer?.name && <InfoRow icon='check' label='packed_by'>
            <Text size='m'>{order.pickFinalizer.name}</Text>
        </InfoRow>}
        {order.shipper?.name && <InfoRow icon='truck' label='shipped_by'>
            <Text size='m'>{order.shipper.name}</Text>
        </InfoRow>}
        {order.cancelReason && <InfoRow icon='x' label='cancel_reason'>
            <Text size='m' mode='error'>{order.cancelReason}</Text>
        </InfoRow>}
    </InfoCard>
}
