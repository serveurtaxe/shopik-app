import classNames from 'common/functions/classNames'
import { useEffect, useState } from 'react'
import styles from './checkbox.module.css'
import Text from '../Text'

export default function Checkbox({ className = '', name, label, switchMode, tagMode, children, defaultValue, defaultChecked = defaultValue, checked, onChange, }) {
    const
        isControlled = checked !== undefined,
        [innerChecked, setInnerChecked] = useState(defaultChecked)

    useEffect(() => {
        if (isControlled) {
            setInnerChecked(checked)
        }
    }, [checked, isControlled])

    function toggleChecked(e) {
        if (!isControlled) {
            setInnerChecked(e.target.checked)
        }
        onChange?.(e)
    }

    const mode = switchMode ? 'switch' : tagMode ? 'tag' : 'checkbox'

    return <label
        className={classNames(
            className,
            styles.cb,
            styles[mode],
            [styles.checked, innerChecked]
        )}
    >
        <input
            type="checkbox"
            name={name}
            checked={isControlled ? checked : undefined}
            defaultChecked={!isControlled ? defaultChecked : undefined}
            onChange={toggleChecked}
        />

        <span className={styles.checkboxCircle}>
            <span className={styles.checkMark}>✓</span>
        </span>

        <Text size='none'>{children || label}</Text>
    </label>
}