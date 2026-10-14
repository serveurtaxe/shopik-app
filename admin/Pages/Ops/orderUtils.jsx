import Flex from "#common/components/Flex/index.jsx"
import Icon from "#common/components/Icon/index.jsx"
import Text from "#common/components/Text/index.jsx"
import TR from 'common/texts/TR.js'
import { formatHour, formatHourRange } from '../Windows/dates.js'
import { useState, useEffect } from 'react'

export const SHIPPING_STATUSES = ['packed', 'shipped']

export function isShippingStatus(status) {
    return SHIPPING_STATUSES.includes(status)
}

// Departure time for the shipping layout (ops_departure_time key).
// Prefers window.startTimestamp (only source with minute precision, e.g. 09:25),
// falls back to the whole-hour window.start (e.g. 09:00).
export function formatDepartureTime(w) {
    if (!w) return '--:--'
    if (w.startTimestamp) {
        const d = new Date(w.startTimestamp)
        if (!isNaN(d.getTime())) {
            return d.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Jerusalem' })
        }
    }
    if (w.start != null) return formatHour(w.start)
    return '--:--'
}

export function formatWindow(w) {
    if (!w) return { text: '', dayText: '', textLong: '', minutes: 0 }

    const range = w.start != null && w.end != null ? formatHourRange(w.start, w.end) : '' // 10:00–12:00
    const withTime = (day) => range ? `${day}, ${range}` : day

    let dayText = '', textLong = ''
    if (w.date) {
        const d = new Date(w.date), today = new Date()
        today.setHours(0, 0, 0, 0); d.setHours(0, 0, 0, 0)
        const diff = Math.round((d - today) / 86400000)
        if (diff === 0 || diff === 1) {
            const day = diff === 0 ? TR('ops_today') : TR('ops_tomorrow')
            dayText = withTime(day)
            textLong = withTime(day)
        } else {
            dayText = withTime(d.toLocaleDateString('he-IL', { weekday: 'short' }))
            textLong = withTime(d.toLocaleDateString('he-IL', { weekday: 'long' })) // e.g. Thursday, 10:00-12:00 (locale Hebrew)
        }
    } else {
        dayText = range
        textLong = range
    }

    if (!w.endTimestamp) return { text: '--:--', dayText, textLong, minutes: 0 }

    const diffMs = new Date(w.endTimestamp).getTime() - Date.now()
    if (diffMs < 0) return { text: '00:00', dayText, textLong, minutes: 0, isLate: true }

    const totalMinutes = Math.floor(diffMs / (1000 * 60))
    const totalHours = Math.floor(totalMinutes / 60)
    const days = Math.floor(totalHours / 24)

    const hours = totalHours % 24
    const minutes = totalMinutes % 60

    const text = days > 0
        ? TR('ops_days_hours', { days, hours: String(hours).padStart(2, '0') })
        : `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`

    return {
        text,
        dayText,
        textLong,
        minutes: totalMinutes,
        isLate: totalMinutes <= 0,
        isAlmostLate: totalMinutes <= 15
    }
}

// Card tone shared by the Ops list and the User order history.
// A finished order is always green; otherwise the tone follows
// window urgency (danger ≤10 min left, warning <60 min).
export function orderCardTone(order) {
    if (order?.status == 'done') return 'success'
    const { minutes } = formatWindow(order?.window)
    if (minutes <= 10) return 'danger'
    if (minutes < 60) return 'warning'
    return null
}

// Live countdown of the time remaining in the window.
// Re-renders every minute so `formatWindow(...).text` never goes stale.
export function RemainingTime({ window: w, ...textProps }) {
    const [, setTick] = useState(0)

    useEffect(() => {
        const id = setInterval(() => setTick(t => t + 1), 60 * 1000)
        return () => clearInterval(id)
    }, [])

    return <Text {...textProps}>{formatWindow(w).text}</Text>
}


// Waze navigation URL for a delivery address.
// Prefers the text query ("street building, city") — Waze resolves it to the
// correct building label. Coordinates are only a fallback when no address text
// exists: a slightly-off pin makes Waze snap to/label the nearest street
// (e.g. "מקס נורדאו" instead of "אוסישקין"), which confuses shippers.
export function buildWazeUrl(address) {
    const streetBuilding = [address?.street, address?.building].filter(v => v != null && v !== '').join(' ')
    const q = [streetBuilding, address?.city].filter(v => v != null && v !== '').join(', ')
    if (q) return `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`
    const coords = address?.location?.coordinates
    if (coords?.length >= 2) return `https://waze.com/ul?ll=${coords[1]},${coords[0]}&navigate=yes`
    return `https://waze.com/ul?navigate=yes`
}

export function DeliveryMethodTag({ deliveryMethod }) {
    return <Flex gap={5} alignItems='center' >
        <Icon name={deliveryMethod == 'pickup' ? 'bag' : 'truck'} />
        <Text bold>{deliveryMethod}</Text>
    </Flex>
}