import HorizontalScroll from 'common/components/HorizontalScroll'
import classNames from 'common/functions/classNames'
import Loader from 'common/components/Loader'
import Text from 'common/components/Text'
import Flex from 'common/components/Flex'
import { useEffect, useState } from 'react'
import styles from './windowPicker.module.css'

// The server reports a few raw state names. Translate the known ones so both
// the storefront and the admin picker read naturally.
const NOTE_KEYS = {
    full: 'windows_full',
    'almost full': 'windows_almost_full',
    closed: 'windows_closed_window'
}

export default function WindowPicker({ days, activeWindowId, loadingId, onSelect, className }) {
    const [activeDay, setActiveDay] = useState(null)

    // Follow the order's current window when the options (re)load, but let the
    // user browse other days without the effect snapping back on every click.
    useEffect(() => {
        if (!days?.length) {
            setActiveDay(prev => prev ? null : prev)
            return
        }

        setActiveDay(prev => {
            const withActive = days.find(day => day.windows?.some(window => window.id === activeWindowId))
            if (withActive) return withActive
            const keptDay = prev && days.find(day => day.date === prev.date)
            return keptDay || days[0]
        })
    }, [days, activeWindowId])

    return <Flex col gap={20} className={classNames(styles.picker, className)}>
        <Text bold>choose day</Text>

        <HorizontalScroll items={days?.map(day => (
            <Flex
                key={day.date}
                className={classNames(styles.day, [styles.active, day.date === activeDay?.date])}
                onClick={() => setActiveDay(day)}
                data-active={day.date === activeDay?.date || undefined}
                gap={5} col center
            >
                <Text bold>{`day-${day.dayOfWeek}-short`}</Text>
                <div>
                    <Text size="s">{day.dayOfMonth} </Text>
                    <Text size="s">{`month-${day.month}-short`}</Text>
                </div>
            </Flex>
        ))} />

        <Text bold>choose window</Text>
        <Flex col gap={10}>
            {activeDay?.windows?.map(window => {
                const isSelected = window.id === activeWindowId
                return (
                    <Flex
                        key={window.id}
                        className={classNames(styles.time, [styles.active, isSelected], [styles.disabled, window.disabled])}
                        onClick={() => onSelect?.(window)}
                        gap={10} justifyContent="space-between" alignItems="center"
                    >
                        <Text bold>{window.end}:00 - {window.start}:00</Text>
                        {loadingId === window.id ? <Loader size={14} /> : (
                            <Text mode="sub">{isSelected ? 'chosen window' : NOTE_KEYS[window.note] || window.note || 'available'}</Text>
                        )}
                    </Flex>
                )
            })}
        </Flex>
    </Flex>
}
