/**
 * Format a Date as YYYY-MM-DD (UTC, ISO date part).
 */
export default function formatISODate(d) {
    return d.toISOString().split('T')[0]
}
