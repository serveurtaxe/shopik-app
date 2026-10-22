import fs from 'fs'
import log from '#server/utils/log.js'

/**
 * One-line memory snapshot.
 *
 * rss is what the container limit kills on — heapUsed alone hides native
 * allocations (XML strings, BSON buffers, Buffers outside the heap). The
 * Comax import streams a catalog that can be hundreds of MB, so both
 * numbers matter when sizing the container.
 */
export function mem(tag, prefix = 'mem') {
    const m = process.memoryUsage()
    const mb = b => Math.round(b / 1024 / 1024)
    log.info(`[${prefix}][mem] ${tag} rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB ext=${mb(m.external)}MB buffers=${mb(m.arrayBuffers)}MB`)
}

function readText(path) {
    try {
        return fs.readFileSync(path, 'utf8').trim()
    } catch {
        return null
    }
}

/**
 * Memory the container is actually allowed to use, in MB.
 *
 * os.totalmem() reports the HOST, not the container — Node then sizes the V8
 * heap from the host and lets it grow far past the container limit, so the
 * kernel OOM-kills the process instead of V8 collecting. Read the cgroup
 * limit instead. Returns null when it cannot be determined.
 */
export function containerMemoryLimitMb() {
    const root = process.env.CONTAINER_CGROUP_ROOT || '/sys/fs/cgroup'

    // cgroup v2
    const v2 = readText(`${root}/memory.max`)
    if (v2) {
        if (v2 === 'max') return null
        const bytes = Number(v2)
        return bytes > 0 ? Math.round(bytes / 1048576) : null
    }

    // cgroup v1
    const v1 = readText(`${root}/memory/memory.limit_in_bytes`)
    if (v1) {
        const bytes = Number(v1)
        // v1 reports a huge sentinel instead of "unlimited"
        if (!bytes || bytes <= 0 || bytes >= 1 << 60) return null
        return Math.round(bytes / 1048576)
    }

    return null
}

/**
 * Hint V8 to collect now. No-op unless the process was started with
 * --expose-gc. Used to keep the RSS flat while a long import churns
 * through hundreds of MB of short-lived objects.
 */
export function collectGarbage() {
    if (typeof global.gc !== 'function') return false
    global.gc()
    return true
}

export default mem
