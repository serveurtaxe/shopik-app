const COMAX_URL = 'https://ws.comax.co.il/Comax_WebServices/items_service.asmx/Get_AllItemsDetailsBySearch'
const COMAX_BALANCE_URL = 'https://ws.comax.co.il/Comax_WebServices/Items_Service.asmx/Get_AllItemsBalanceBySearch'
const COMAX_PROMOTIONS_URL = 'https://ws.comax.co.il/Comax_WebServices/Promotions_Service.asmx/GetPromotionsDef'

async function fetchComaxXml({ url, params, timeoutMs = 120000, action, skipLog }, { DL }) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let logPromise, log
    try {
        const fullUrl = `${url}?${new URLSearchParams(params)}`
        // skipLog: per-item backfills fire tens of thousands of requests; one Log
        // doc each would flood the collection. Callers opt out explicitly.
        if (!skipLog) {
            const logData = {
                action,
                direction: DL.Log.constants.DIRECTION.OUT,
                data: { request: { url: fullUrl, params } }
            }
            log = DL.Log.start(logData)
            log.actor({ type: DL.Log.constants.ACTOR.API })
        }
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

