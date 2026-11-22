// Injects the Vee accessibility widget, mirroring their official snippet:
// `window.args` carries the whole config and their script is fetched from
// `<access>/js/` with defer + crossOrigin="anonymous" + data-cfasync.
//
// Three deliberate differences from the snippet:
//  - nothing is fetched before the page has loaded (capped at MAX_WAIT_MS), so
//    the vendor bundle never competes with LCP or the hydration work;
//  - the injection is guarded by id + a global flag, so StrictMode's
//    double-invoke and SPA remounts cannot load it twice;
//  - failures stay silent in the console (debug level): a vendor outage must
//    never look like a storefront error.
import { buildVeeArgs, veeScriptUrl } from 'common/functions/vee.js'

const SCRIPT_ID = 'vee-accessibility-script'
const IDLE_TIMEOUT_MS = 2000
const NO_IDLE_CALLBACK_DELAY_MS = 1000
// The load event can be many seconds away on a slow connection; accessibility
// must not wait for it indefinitely. Measured from mount (after hydration).
const MAX_WAIT_MS = 5000

export function loadVee(config) {
    if (!config?.sitekey) return false
    if (typeof document === 'undefined' || !document.body) return false

    // Already injected (SPA remount) or already running (StrictMode re-run).
    if (window.__veeAccessibilityLoaded || document.getElementById(SCRIPT_ID)) return true

    const args = buildVeeArgs(config)
    if (!args) return false

    // The vendor script reads the global `window.args` when it executes; it is
    // set right before the tag is appended and deliberately left in place.
    window.args = args

    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.defer = true
    // Their snippet opts into CORS mode and their CDN serves it; keep the same
    // behavior so the fetch is identical to every other Vee customer.
    script.crossOrigin = 'anonymous'
    script.setAttribute('data-cfasync', 'true')
    script.src = veeScriptUrl(config.access)
    script.onload = () => { window.__veeAccessibilityLoaded = true }
    script.onerror = () => console.debug('[vee] accessibility script failed to load')

    document.body.appendChild(script)
    return true
}

// Defers the injection until after `load`, then into an idle callback: nothing
// is fetched before the page itself is done, and the widget's JS runs outside
// the window Lighthouse measures for TBT. Returns a cancel function.
export function loadVeeAfterPageLoad(config) {
    let cancelled = false
    let started = false
    let idleHandle = null
    let delayTimer = null
    let capTimer = null

    function run() {
        if (cancelled || started) return
        started = true
        idleHandle = null
        delayTimer = null
        clearTimeout(capTimer)
        window.removeEventListener('load', start)
        loadVee(config)
    }

    function start() {
        if (cancelled || started) return
        if (typeof window.requestIdleCallback === 'function')
            idleHandle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS })
        else
            // Safari has no requestIdleCallback; a plain delay does the same job.
            delayTimer = setTimeout(run, NO_IDLE_CALLBACK_DELAY_MS)
    }

    if (document.readyState === 'complete') start()
    else window.addEventListener('load', start, { once: true })

    capTimer = setTimeout(run, MAX_WAIT_MS)

    return () => {
        cancelled = true
        window.removeEventListener('load', start)
        if (idleHandle !== null) window.cancelIdleCallback?.(idleHandle)
        if (delayTimer !== null) clearTimeout(delayTimer)
        if (capTimer !== null) clearTimeout(capTimer)
    }
}
