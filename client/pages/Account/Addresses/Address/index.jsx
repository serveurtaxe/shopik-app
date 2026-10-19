import classNames from 'common/functions/classNames'
import styles from './address.module.css'
import mapImage from './map.png'
import Button from 'common/components/Button'
import ConfirmButton from 'common/components/ConfirmButton'
import Image from 'common/components/Image'
import Card from 'common/components/Card'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import { useText } from 'common/texts/TextProvider'

export default function Address({ store, address = {}, active: activeProp, action = {}, onEdit, onRemove, blink = false }) {
    const { city, street, apartment, building, active: addressActive, hasService } = store?.address || address
    const active = activeProp ?? addressActive
    const isNoService = !store && hasService === false
    const isDisabled = !!action.disabled || isNoService
    const { TR } = useText?.() || {}

    return <Flex
        onClick={isDisabled ? undefined : action.onClick}
        tag={Card} gap={10} className={classNames(styles.address, [styles.active, active && !isNoService], [styles.disabled, isDisabled || isNoService], [styles.blink, blink && isNoService])}>
        <Image size={74} src={mapImage} />

        <Flex col gap={7} justifyContent='center'>
            <Text size='s'>{store ? 'store_address_title' : 'address_title'}</Text>
            <Text bold>{store?.name ? `${store.name} - ` : ''}{street} {building} {apartment && `${TR?.('apartment')} ${apartment}`}</Text>
            <Text bold>{city}</Text>
        </Flex>

        <Flex col justifyContent='space-between' grow={1}>
            {!store && (onEdit || onRemove) && <Flex gap={10} justifyContent='end' className={styles.buttons}>
                {onEdit && <Button icon='edit' mode='text' onClick={() => onEdit(address)} stopPropagation preventDefault />}
                {onRemove && <ConfirmButton
                    icon='trash' mode='text'
                    q='remove_address_confirm'
                    stopPropagation preventDefault
                    onOk={() => onRemove(address)}
                />}
            </Flex>}
            {isNoService
                ? <Text size="s" className={classNames(styles.actionButton, styles.noService)}>no_service</Text>
                : <Button {...action} mode='text' text={active ? 'active' : action.text} className={styles.actionButton} />}
        </Flex>
    </Flex>
}
