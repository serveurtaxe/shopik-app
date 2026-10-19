import Flex from 'common/components/Flex'
import Icon from 'common/components/Icon'
import Text from 'common/components/Text'
import styles from './headerPopoverButton.module.css'

/**
 * Shared header popover trigger (delivery + user buttons):
 * icon, two-line label and chevron that rotates while open.
 * Title/subtitle accept translation keys or plain strings.
 */
export default function HeaderPopoverButton({ icon, title, subtitle, onClick }) {
    return <Flex alignItems='center' gap={10} className={styles.button} onClick={onClick}>
        <Icon name={icon} className={styles.icon} />
        <Flex alignItems='center' justifyContent='space-between' grow={1} className='btnTexts'>
            <Flex col gap={3}>
                <Text bold size='m'>{title}</Text>
                <Text size='s'>{subtitle}</Text>
            </Flex>
            <Icon name='down' className={styles.chevron} />
        </Flex>
    </Flex>
}
