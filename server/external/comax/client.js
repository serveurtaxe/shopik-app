import { Readable } from 'node:stream'

const COMAX_URL = process.env.COMAX_PRODUCTS_URL || 'https://ws.comax.co.il/Comax_WebServices/items_service.asmx/Get_AllItemsDetailsBySearch'
const COMAX_BALANCE_URL = 'https://ws.comax.co.il/Comax_WebServices/Items_Service.asmx/Get_AllItemsBalanceBySearch'
const COMAX_PROMOTIONS_URL = 'https://ws.comax.co.il/Comax_WebServices/Promotions_Service.asmx/GetPromotionsDef'

function buildUrl(url, params) {
    return `${url}?${new URLSearchParams(params)}`
}

/**
 * Never write the Comax password to the log collection.
 * The request params carry LoginPassword in clear text.
 */
function redactParams(params) {
    if (!params) return params
    return { ...params, LoginPassword: params.LoginPassword ? '***' : params.LoginPassword }
}

function startLog({ DL, action, fullUrl, params, skipLog }) {
    // skipLog: per-item backfills fire tens of thousands of requests; one Log
    // doc each would flood the collection. Callers opt out explicitly.
    if (skipLog) return null
    const log = DL.Log.start({
        action,
        direction: DL.Log.constants.DIRECTION.OUT,
        data: { request: { url: fullUrl, params: redactParams(params) } }
    })
    log.actor({ type: DL.Log.constants.ACTOR.API })
    return log
}

async function fetchComaxXml({ url, params, timeoutMs = 120000, action, skipLog }, { DL }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let logPromise, log
    try {
        const fullUrl = buildUrl(url, params)
        log = startLog({ DL, action, fullUrl, params, skipLog })
        const response = await fetch(fullUrl, { signal: controller.signal })
        if (!response.ok) throw new Error(`Comax HTTP ${response.status}: ${response.statusText}`)
        const xml = await response.text()
        if (log) logPromise = log.success(`xml: ${xml.length} characters`)
        return xml
    } catch (error) {
        if (log) {
            logPromise = log.error({ message: error.message, stack: error.stack })
        }
        throw error
    } finally {
        if (logPromise) await logPromise
        clearTimeout(timer)
    }
}

export async function fetchComax({ params, timeoutMs = 120000, skipLog }, { DL }) {
    return fetchComaxXml({ url: COMAX_URL, params, timeoutMs, action: 'comax_fetch_products', skipLog }, { DL })
}

/**
 * Stream the products response instead of buffering it.
 *
 * The catalog can be hundreds of MB (a mass price update makes the Comax
 * delta the whole catalog). `response.text()` materialised all of it as one
 * string before a single item could be parsed — that alone exhausted the
 * container memory limit. This hands back the body as a stream so the caller
 * can parse item by item.
 *
 * The timeout is an IDLE timeout (reset on every chunk), not a total one: a
 * slow but healthy multi-minute download must not be killed half way.
 *
 * @returns {AsyncGenerator<Buffer>} yields the raw response body
 */
export async function fetchComaxStream({ params, timeoutMs = 600000, skipLog, action = 'comax_fetch_products' }, { DL }) {
    const controller = new AbortController()
    let logPromise, log
    let timer

    const armIdleTimer = () => {
        clearTimeout(timer)
        timer = setTimeout(() => controller.abort(new Error(`Comax request idle for ${timeoutMs}ms`)), timeoutMs)
    }

    try {
        const fullUrl = buildUrl(COMAX_URL, params)
        log = startLog({ DL, action, fullUrl, params, skipLog })

        // Armed before the request so a server that never answers the headers
        // is aborted too, not just a stalled download.
        armIdleTimer()
        const response = await fetch(fullUrl, { signal: controller.signal })
        if (!response.ok) throw new Error(`Comax HTTP ${response.status}: ${response.statusText}`)
        if (!response.body) throw new Error('Comax response had no body')

        armIdleTimer()
        const body = Readable.fromWeb(response.body)
        let bytes = 0

        async function* chunks() {
            try {
                for await (const chunk of body) {
                    bytes += chunk.length
                    armIdleTimer()
                    yield chunk
                }
                if (log) logPromise = log.success(`xml: ${bytes} bytes`)
            } catch (e) {
                if (log) logPromise = log.error({ message: e.message, stack: e.stack })
                throw e
            } finally {
                clearTimeout(timer)
                if (logPromise) await logPromise
            }
        }
        return chunks()
    } catch (error) {
        if (log) {
            logPromise = log.error({ message: error.message, stack: error.stack })
        }
        clearTimeout(timer)
        if (logPromise) await logPromise
        throw error
    }
}

export async function fetchComaxBalance({ params, timeoutMs = 120000 }, { DL }) {
    return fetchComaxXml({ url: COMAX_BALANCE_URL, params, timeoutMs, action: 'comax_fetch_balance' }, { DL })
}

export async function fetchComaxPromotions({ params, timeoutMs = 120000 }, { DL }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let logPromise, log
    try {
        const bodyData = {
            Params: typeof params === 'string' ? params : JSON.stringify(params),
            LoginID: process.env.COMAX_LOGIN_ID,
            LoginPassword: process.env.COMAX_LOGIN_PASSWORD
        }
        const logData = {
            action: 'comax_fetch_promotions',
            direction: DL.Log.constants.DIRECTION.OUT,
            data: {
                request: {
                    url: COMAX_PROMOTIONS_URL,
                    body: bodyData
                }
            }
        }
        log = DL.Log.start(logData)
        log.actor({ type: DL.Log.constants.ACTOR.API })

        const response = await fetch(COMAX_PROMOTIONS_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify(bodyData),
            signal: controller.signal
        })

        if (!response.ok)
            throw new Error(`Comax HTTP ${response.status}: ${response.statusText}`)

        const json = await response.json()
        const promotions = json?.d || []
        logPromise = log.success(`promotions count: ${promotions.length}`)
        return promotions
    } catch (error) {
        if (log) {
            const errorData = {
                message: error.message,
                stack: error.stack
            }
            logPromise = log.error(errorData)
        }
        throw error
    } finally {
        if (logPromise)
            await logPromise
        clearTimeout(timer)
    }
}
