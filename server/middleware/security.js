import helmet from 'helmet'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import { expandOrigins, normalizeHostname } from '#server/utils/normalizeDomain.js'
import { isProdEnv } from '#server/utils/isProd.js'

// Re-exported for the modules that already import it from here.
export { isProdEnv }

const REFRESH_MS = 3_600_000 // 1h — new/disabled domains are rare; restarts reload immediately
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 1000 // shared store/office IPs: tens of pickers per IP; still far below script abuse

async function loadAllowedOrigins(DL, warn) {
    try {
        const domains = await DL.Domain.read({ active: true }, { url: 1 }, { limit: 0 })
        const allowed = new Set()
        const prodOnly = isProdEnv()
        for (const d of domains || []) {
            if (!d?.url) continue
            try {
                for (const origin of expandOrigins(normalizeHostname(d.url))) {
                    // Prod serves HTTPS only: never allow credentialed http://
                    // origins in production (downgrade/MITM). Local dev keeps
                    // http:// (this loader only runs in prod anyway).
                    if (prodOnly && origin.startsWith('http://')) continue
                    allowed.add(origin)
                }
            } catch {
                // skip invalid stored urls (admin can fix via Domains page)
            }
        }
        return allowed
    } catch (e) {
        warn?.('CORS allowlist load failed (fail-closed, keeping previous):', e?.message || e)
        return null
    }
}

export default async function setupSecurity(app, bootData) {
    const warn = bootData?.utils?.log?.warn?.bind(bootData.utils.log) || console.warn

    app.set('trust proxy', 1)

    // Lenient start: CSP + COEP disabled (SSR inlines <style> and window.__SD__).
    // Tighten with nonces in a follow-up.
    // DISABLE_FRAMEGUARD=true lifts X-Frame-Options / frame-ancestors (e.g. so the
    // Hyp payment iframe can frame the callback cross-origin in test envs).
    // NEVER honored in prod — fail-safe default is helmet ON everywhere.
    const disableFrameguard = process.env.DISABLE_FRAMEGUARD === 'true' && !isProdEnv()
    app.use(helmet({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false,
        // helmet defaults to `no-referrer`, which strips the header (and
        // document.referrer) from every request the page makes. Two real
        // consumers depend on it:
        //  - Vee's accessibility toolbar is fetched by an XHR to vee-crm.com and
        //    their server answers a request without HTTP_REFERER with
        //    "No referer", so the widget renders an error bar;
        //  - the Hyp payment page is loaded in an iframe
        //    (client/pages/Checkout/index.jsx), whose initial request also lost
        //    its referrer.
        // Keep the browser default instead: full URL same-origin, origin only
        // cross-origin — third parties still never see our paths or query.
        referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
        frameguard: disableFrameguard ? false : undefined
    }))

    if (!isProdEnv()) return { allowedOrigins: null }

    let allowed = (await loadAllowedOrigins(bootData.DL, warn)) || new Set()
    const refresher = setInterval(async () => {
        const next = await loadAllowedOrigins(bootData.DL, warn)
        if (next) allowed = next
    }, REFRESH_MS)
    refresher.unref?.()

    app.use('/api', cors({
        origin: (origin, cb) => {
            if (!origin) return cb(null, true)
            cb(null, allowed.has(origin))
        },
        credentials: true
    }))

    app.use('/api', rateLimit({
        windowMs: RATE_WINDOW_MS,
        max: RATE_MAX,
        standardHeaders: true,
        legacyHeaders: false
    }))

    return { get allowedOrigins() { return allowed } }
}
