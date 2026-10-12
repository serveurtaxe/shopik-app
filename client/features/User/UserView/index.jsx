import Popover from '#common/components/Popover'
import AuthPanel from 'features/User/AuthPanel'
import { useUser } from 'features/User'
import HeaderPopoverButton from 'common/components/HeaderPopoverButton'
import { getUserTitle, getUserSubtitle } from 'common/functions/userLabel'


export default function UserView({ }) {
    const user = useUser()

    return <Popover
        id='login'
        overlay
        modal={false}
        topOffset={10}
        button={<HeaderPopoverButton
            icon='user'
            title={getUserTitle(user)}
            subtitle={getUserSubtitle(user)}
        />}
    >
        {({ close }) => <AuthPanel onClose={close} />}
    </Popover>
}
