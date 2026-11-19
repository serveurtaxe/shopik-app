import Card from 'common/components/Card'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Icon from 'common/components/Icon'
import classNames from 'common/functions/classNames'
import styles from './detail.module.css'

export function InfoRow({ icon, label, children }) {
    return <Flex gap={12} alignItems='flex-start'>
        <Icon name={icon} size={22} className={styles.infoIcon} />
        <Flex col gap={4}>
            {label && <Text size='l' bold>{label}</Text>}
            {children}
        </Flex>
    </Flex>
}

export default function InfoCard({ title, children, className = '', action = null }) {
    return <Card className={classNames(styles.detailsCard, className)}>
        {(title || action) && <Flex gap={8} alignItems='center' justifyContent='space-between' className={styles.cardTitle}>
            {title && <Text size='h3' bold>{title}</Text>}
            {action}
        </Flex>}
        <Flex col gap={22}>
            {children}
        </Flex>
    </Card>
}
