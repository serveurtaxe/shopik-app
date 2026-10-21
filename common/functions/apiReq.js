const isClient = typeof window !== 'undefined'

export default async function apiReq(path, data = {}, ctx) {
    let body = data

    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'app-version': APP_VERSION
    }

    // SSR calls run in a separate internal request that has no browser cookie
    // jar. Forward the original request identity when the server passes it so
    // auth ('lax') routes can resolve the current user.
    if (!isClient && ctx) {
        if (ctx.cookie) headers.cookie = ctx.cookie
        if (ctx.platform) headers.platform = ctx.platform
    }

    if (data.files) {
        const fData = new FormData()
        Object.keys(data.files).forEach(k => {
            Array.from(data.files[k]).forEach(f => fData.append('files', f, `${k}:${f.name}`))
        })
        delete data.files
        fData.append('fData', JSON.stringify(body))
        body = fData
        delete headers['Content-Type']
    } else
        body = JSON.stringify(body)

    try {
        const
            base = isClient ? '' : (process.env.INTERNAL_API_URL || `http://localhost:${process.env.PORT || 1990}`),
            res = await fetch(`${base}/api/${path}`, {
                method: 'POST',
                body,
                headers,
                credentials: 'same-origin'
            }),
            result = await res.json().catch(() => ({ status: res.status, message: `HTTP ${res.status}` }))

        if (!res.ok || result.status !== 200) throw result
        return result.data
    } catch (err) {
        if (err.status === 401 && isClient && !window.__reloading) {
            window.__reloading = true
            location.reload()
        }
        // Preserve structured errors (e.g. MISSING_FIELDS) so callers can inspect missingFields
        if (err && typeof err === 'object' && (err.missingFields || err.code === 'MISSING_FIELDS')) throw err
        if (err && typeof err === 'object' && err.message) {
            // attach raw payload to string error for callers that check err.missingFields
            const e = new Error(err.message)
            Object.assign(e, err)
            throw e
        }
        throw err?.message || err
    }
}