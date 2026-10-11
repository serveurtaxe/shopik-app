import Popover from '#common/components/Popover'
import styles from './userView.module.css'
import Icon from '#common/components/Icon'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import AuthPanel from 'features/User/AuthPanel'
import { useUser } from 'features/User'


export default function UserView({ }) {
    const user = useUser()

    return <Popover
        id='login'
        overlay
        modal={false}
        topOffset={10}
        button={<Flex alignItems='center' gap={10} className={styles.button}>
            <Icon name='user' className={styles.icon} />
            <Flex alignItems='center' justifyContent='space-between' grow={1} className='btnTexts'>
                <Flex col gap={3}>
                    <Text bold size='s'>{user?.id ? `good ${getTimeOfDay()}` : 'login_register_btn'}</Text>
                    <Text size='xs'>{user?.id ? `${user.name?.first || ''} ${user.name?.last || ''}` : 'login_register_subTitle'}</Text>
                </Flex>
                <Icon name='down' className={styles.chevron} />
            </Flex>
        </Flex>}
    >
        {({ close }) => <AuthPanel onClose={close} />}
    </Popover>
}

function getTimeOfDay() {
    const hour = new Date().getHours()

    if (hour >= 5 && hour < 12) {
        return "morning"
    } else if (hour >= 12 && hour < 17) {
        return "afternoon"
    } else if (hour >= 17 && hour < 21) {
        return "evening"
    } else {
        return "night"
    }
}
