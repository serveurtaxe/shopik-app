import { normalizeHostname, rootHostname } from '#server/utils/normalizeDomain.js'

const REFRESH_MS = 3_600_000

/**
 * Returns the canonical host for a www request, or null when the host is not a
 * www alias of a configured storefront/domain. Restricting the target to the
 * bare domain or its admin subdomain prevents Host-header open redirects.
 */
export function getWwwRedirect(host, knownRoots) {
    const raw = String(host || '').trim().toLowerCase()
    if (!raw.startsWith('www.')) return null

    const target = raw.slice(4)
    const hostname = target.split(':')[0]
    if (!hostname) return null

    let root
    try {
        root = rootHostname(normalizeHostname(hostname))
    } catch {
        return null
    }

    if (!knownRoots.has(root)) return null
    if (hostname !== root && hostname !== `admin.${root}`) return null

    return target
}

async function loadKnownRoots(DL, warn) {
    try {
        const domains = await DL.Domain.read({ active: true }, { url: 1 }, { limit: 0 })
        const roots = new Set()
        for (const d of domains || []) {
            if (!d?.url) continue
            try {
                roots.add(rootHostname(normalizeHostname(d.url)))
            } catch {
                // Skip invalid stored urls — the admin can fix them via the Domains page.
            }
        }
        return roots
    } catch (e) {
        warn?.('www redirect domain list load failed (keeping previous):', e?.message || e)
        return null
    }
}

export default async function setupWwwRedirect(app, DL, warn) {
    let knownRoots = (await loadKnownRoots(DL, warn)) || new Set()
    const refresher = setInterval(async () => {
        const next = await loadKnownRoots(DL, warn)
        if (next) knownRoots = next
    }, REFRESH_MS)
    refresher.unref?.()

    app.use((req, res, next) => {
        // CORS preflights must not be redirected; the allowlist already covers www.
        if (req.method === 'OPTIONS') return next()

        const target = getWwwRedirect(req.headers.host, knownRoots)
        if (!target) return next()

        const status = req.method === 'GET' || req.method === 'HEAD' ? 301 : 308
        return res.redirect(status, `${req.protocol}://${target}${req.originalUrl}`)
    })
}
