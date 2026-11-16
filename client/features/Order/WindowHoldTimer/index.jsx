import { useEffect, useRef, useState } from 'react'
import { useText } from 'common/texts/TextProvider'
import { holdDeadline } from '../windowHold'
import styles from './windowHoldTimer.module.css'

const WARNING_WINDOW_MS = 5 * 60 * 1000

function formatRemaining(ms) {
    const totalSeconds = Math.ceil(ms / 1000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = totalSeconds % 60
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * Countdown for the reservation hold: "the window is kept for 12:34".
 * During the last five minutes the text gradually shifts to the danger colour.
 */
export default function WindowHoldTimer({ window, onExpire }) {
    const { TR } = useText() || {}
    const deadline = holdDeadline(window)
    const [now, setNow] = useState(null)
    const expiredRef = useRef(false)

    useEffect(() => {
        expiredRef.current = false
        if (deadline == null) return
        setNow(Date.now())
        const id = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(id)
    }, [deadline])

    const remaining = deadline == null || now == null ? null : deadline - now

    useEffect(() => {
        if (remaining == null || remaining > 0 || expiredRef.current) return
        expiredRef.current = true
        onExpire?.()
    }, [remaining, onExpire])

    if (remaining == null || remaining <= 0) return null

    const progress = remaining < WARNING_WINDOW_MS
        ? (WARNING_WINDOW_MS - remaining) / WARNING_WINDOW_MS
        : 0
    const time = formatRemaining(remaining)
    const label = (TR?.('window_hold_remaining') || 'window_hold_remaining').replace('{time}', time)

    return (
        <span
            className={`${styles.holdTimer} ${progress > 0 ? styles.urgent : ''}`}
            style={{ '--hold-progress': String(progress) }}
        >
            {label}
        </span>
    )
}
