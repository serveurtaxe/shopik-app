// Shared small helpers for the stress tool.

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

export function percentile(sorted, p) {
    if (!sorted.length) return null
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    return sorted[Math.max(0, idx)]
}

export function latencyStats(durations) {
    if (!durations.length) return { count: 0 }
    const sorted = [...durations].sort((a, b) => a - b)
    return {
        count: sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
        max: sorted[sorted.length - 1]
    }
}

export function maskPhone(phone) {
    const s = String(phone || '')
    return s.length > 4 ? `${s.slice(0, 3)}…${s.slice(-2)}` : '??'
}

export function currentMonth() {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

// Simple async worker pool: runs `task(index)` over n items with c concurrent.
export async function pool(n, concurrency, task) {
    const results = new Array(n)
    let cursor = 0
    const worker = async () => {
        while (true) {
            const i = cursor++
            if (i >= n) return
            results[i] = await task(i)
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, n)) }, worker)
    await Promise.all(workers)
    return results
}

export function fmtMs(ms) {
    if (ms == null) return '—'
    return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}
