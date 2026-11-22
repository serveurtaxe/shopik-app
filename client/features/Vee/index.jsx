import { useEffect } from 'react'
import { useAppData } from 'App'
import { resolveVeeConfig } from 'common/functions/vee.js'
import { loadVeeAfterPageLoad } from './loader.js'

// Renders nothing of its own: the accessibility launcher is injected into the
// document by the Vee script. `settings` comes from window.__SD__ at boot and
// never changes client-side, so the effect runs once per page. Re-injection is
// guarded inside loadVee, which keeps StrictMode's double-invoke and SPA
// remounts safe.
//
// resolveVeeConfig is the single gate: production-only (env.PROD) plus an
// enabled, fully-filled integrations.vee setting. The same call decides the
// head preconnect in entry-server.jsx, so the two can never disagree.
export default function VeeAccessibility() {
    const { settings, env } = useAppData() || {}

    useEffect(() => {
        const config = resolveVeeConfig(settings, env)
        if (!config) return
        return loadVeeAfterPageLoad(config)
    }, [])

    return null
}
