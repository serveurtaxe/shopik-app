import Icon from 'common/components/Icon'
import Text from 'common/components/Text'
import styles from './backButton.module.css'

export default function BackButton({ children, onBack }) {
    return <button type='button' className={styles.backButton} onClick={onBack}>
        <Icon name='right' />
        <Text bold size='l'>{children || 'back'}</Text>
    </button>
}
