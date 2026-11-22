// Status codes per https://developers.hyp.co.il/pay/reference/response-status-codes
// (Shva network codes passed through Hyp, plus Hyp Pay codes)
const CCODE_MESSAGES = {
    0: 'Success',
    1: 'Blocked card',
    2: 'Stolen card, confiscate',
    3: 'Call the credit card company',
    4: 'Transaction not approved',
    5: 'Forged card, confiscate',
    6: 'Transaction declined: incorrect CVV2',
    10: 'Partial approval',
    12: 'Card not permitted in the terminal',
    14: 'Card not associated with the network',
    15: 'Card is not valid',
    26: 'Transaction declined: incorrect ID',
    33: 'Refund exceeds original amount',
    200: 'Missing parameters from the payment completion redirect',
    250: 'Transaction or payment link not found',
    400: 'Sum of items differs from transaction amount',
    401: 'First or last name is required',
    402: 'Transaction information is required',
    403: 'Transaction amount is smaller than the minimum amount',
    415: 'Invalid data entered',
    416: 'Expiration date is not in a valid format',
    417: 'Terminal number is incorrect',
    418: 'Essential parameters are missing',
    421: 'General error - invalid data',
    426: 'The amount was increased after performing checks',
    429: 'Card is not valid according to the valid cards file',
    447: 'Incorrect card number',
    507: 'Actual transaction amount is higher than the approved amount',
    599: 'General error',
    600: 'Transaction details received (J2)',
    700: 'Authorized (J5 hold)',
    800: 'Postponed success',
    920: 'Already transmitted — cannot cancel, refund instead',
    777: 'Reversal success'
}

// Hyp Brand param (numeric index) → card company name
const CARD_COMPANIES = ['PL', 'MasterCard', 'Visa', 'Maestro', '', 'Isracard']

function getConfig() {
    const masof = process.env.HYP_MASOF
    const key = process.env.HYP_KEY
    const passp = process.env.HYP_PASSP
    const baseUrl = process.env.HYP_BASE_URL || 'https://pay.hyp.co.il/p/'
    if (!masof || !key || !passp) throw { status: 500, message: 'Hyp credentials not configured' }
    return { masof, key, passp, baseUrl: baseUrl.endsWith('/') ? baseUrl : baseUrl + '/' }
}

function parseHypResponse(text) {
    const params = new URLSearchParams(text.trim())
    const obj = {}
    for (const [k, v] of params.entries()) obj[k] = v
    if (obj.CCode !== undefined) obj.CCode = Number(obj.CCode)
    if (obj.Amount !== undefined) obj.Amount = Number(obj.Amount)
    return obj
}

// Names occasionally arrive HTML-entity-encoded (e.g. '&#1488;' for א).
// Decode numeric entities so Hyp receives/stores plain text.
function decodeEntities(s) {
    return String(s ?? '').replace(/&#(\d+);/g, (_, n) => {
        const c = Number(n)
        return c > 0 && c < 0x110000 ? String.fromCodePoint(c) : _
    })
}

// Hyp getToken returns Tokef in YYMM format (e.g. '2912' = Dec 2029).
// Shva rejects anything else with CCode 416.
function parseTokef(tokef) {
    const s = String(tokef ?? '')
    if (!/^\d{2}(0[1-9]|1[0-2])$/.test(s))
        throw { status: 402, code: 'PAYMENT_AUTH_MISSING', message: 'תוקף הכרטיס השמור אינו תקין — לא ניתן לחייב (קוד 416)' }
    return { tmonth: s.slice(2), tyear: s.slice(0, 2) }
}

async function hypFetch(url, { timeoutMs = 15000 } = {}) {
    const controller = new AbortController()
    const t = setTimeout(() => controller.abort(), timeoutMs)
    try {
        const res = await fetch(url, { signal: controller.signal })
        const text = await res.text()
        return text
    } finally {
        clearTimeout(t)
    }
}

const DEFAULT_MAX_PAYMENTS = 6

function normalizeMaxPayments(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_MAX_PAYMENTS
    const n = Number(value)
    if (!Number.isFinite(n)) return DEFAULT_MAX_PAYMENTS
    return Math.min(36, Math.max(1, Math.trunc(n)))
}

// A charge without an explicit installment count is a single payment — never
// inherit SIGN's maxPayments default here.
export function normalizeChargePayments(value) {
    if (value === undefined || value === null || value === '') return 1
    const n = Number(value)
    if (!Number.isFinite(n) || n < 1) return 1
    return Math.min(36, Math.trunc(n))
}

// Hyp's action=soft charge accepts Tash/tashType for token charges. The J4
// capture uses the same action, so pass the count the customer picked on the
// payment page instead of letting Hyp fall back to a single charge.
export function applyChargeInstallments(params, payments) {
    const count = normalizeChargePayments(payments)
    if (count > 1) {
        params.set('Tash', String(count))
        params.set('tashType', '1')
    } else {
        params.delete('Tash')
        params.delete('tashType')
    }
    return params
}

export function buildSignQuery({ masof, key, passp, amount, orderNumber, orderId, customer, tmp, maxPayments = DEFAULT_MAX_PAYMENTS }) {
    const payments = normalizeMaxPayments(maxPayments)
    const params = new URLSearchParams()
    params.set('action', 'APISign')
    params.set('What', 'SIGN')
    params.set('Sign', 'True')
    params.set('UTF8', 'True')
    params.set('UTF8out', 'True')
    params.set('Masof', masof)
    params.set('KEY', key)
    params.set('PassP', passp)
    params.set('Amount', String(amount))
    params.set('Order', String(orderNumber))
    params.set('J5', 'True')
    params.set('MoreData', 'True')
    params.set('Coin', '1')
    params.set('tmp', tmp)
    // Tash is the maximum the customer may pick on Hyp's payment page;
    // FixTash=False keeps the payment selector editable.
    params.set('Tash', String(payments))
    params.set('FixTash', payments > 1 ? 'False' : 'True')
    params.set('tashType', '1')

    if (orderId) params.set('Info', String(orderId))
    if (customer?.name?.first) params.set('ClientName', decodeEntities(customer.name.first))
    if (customer?.name?.last) params.set('ClientLName', decodeEntities(customer.name.last))
    if (customer?.phone) {
        const digits = String(customer.phone).replace(/\D/g, '')
        params.set('phone', digits)
    }
    if (customer?.email) {
        params.set('email', customer.email)
    }
    return params.toString()
}

// Secrets must never reach the logs: PassP/KEY/token/CC, in objects and URLs.
const SECRET_KEY_RE = /^(passp|key|token|cc|password|cvv|sign)$/i
function redact(value) {
    if (typeof value === 'string')
        return value.replace(/(KEY|PassP|Token|CC)=([^&\s]*)/g, '$1=***')
    if (Array.isArray(value)) return value.map(redact)
    if (value && typeof value === 'object') {
        const out = {}
        for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY_RE.test(k) ? '***' : redact(v)
        return out
    }
    return value
}

export default function hypFactory({ DL }) {
    // Provider traffic log (Logs admin page, action `hyp:<name>`) — same
    // pattern as external/sms. Secrets (PassP/KEY/token/CC) are redacted and
    // every logging step is guarded so logging can never break a payment.
    async function logged(name, request, fn) {
        let logger = null
        try {
            logger = DL?.Log?.start?.({
                action: `hyp:${name}`,
                direction: DL?.Log?.constants?.DIRECTION?.OUT || 'out',
                data: { request: redact(request) }
            })
            try { logger?.actor?.({ type: DL?.Log?.constants?.ACTOR?.API || 'api' }) } catch { }
        } catch { logger = null }
        const done = async (ok, payload) => {
            try { await logger?.[ok ? 'success' : 'error']?.(payload) } catch { }
        }
        try {
            const result = await fn()
            const code = Number(result?.CCode ?? 0)
            await done(code === 0 || code === 700 || code === 777, redact(result))
            return result
        } catch (e) {
            await done(false, { message: e?.message || 'error', providerCode: e?.providerCode })
            throw e
        }
    }

    async function createPaymentUrl({ order, amount, customer, maxPayments = DEFAULT_MAX_PAYMENTS }) {
        return logged('sign', { amount, orderNumber: order.number, orderId: order.id, maxPayments }, async () => {
            const { masof, key, passp, baseUrl } = getConfig()
            const query = buildSignQuery({
                masof, key, passp,
                amount,
                orderNumber: order.number,
                orderId: order.id,
                customer: customer || { name: order.name, phone: order.phone, email: order.email },
                tmp: 6,
                maxPayments
            })
            const text = await hypFetch(`${baseUrl}?${query}`)
            if (!text || text.includes('CCode') && text.includes('CCode=')) {
                // Some error responses are still query strings with CCode !=0
                const parsed = parseHypResponse(text)
                if (parsed.CCode && parsed.CCode !== 0) {
                    throw { status: 502, message: `Hyp SIGN failed: ${CCODE_MESSAGES[parsed.CCode] || parsed.CCode}`, providerCode: parsed.CCode, raw: parsed }
                }
            }
            // Success: text is signed param string
            const trimmed = text.trim()
            return `${baseUrl}?${trimmed}`
        })
    }

    async function verifyRedirect({ query, rawQueryString }) {
        return logged('verify', { query: redact(query) }, async () => {
            const { masof, key, passp, baseUrl } = getConfig()
            // Preserve original param order: use rawQueryString if provided, else build from query
            let redirectPart = rawQueryString || new URLSearchParams(query).toString()
            // hyp expects all redirect params appended after Masof/KEY/PassP in original order
            const verifyQuery = `action=APISign&What=VERIFY&Masof=${encodeURIComponent(masof)}&KEY=${encodeURIComponent(key)}&PassP=${encodeURIComponent(passp)}&${redirectPart}`
            const text = await hypFetch(`${baseUrl}?${verifyQuery}`)
            const parsed = parseHypResponse(text)
            return parsed // CCode=0 means valid
        })
    }

    async function getToken(providerTxnId) {
        return logged('getToken', { TransId: String(providerTxnId) }, async () => {
            const { masof, passp, baseUrl } = getConfig()
            const params = new URLSearchParams({ action: 'getToken', Masof: masof, PassP: passp, TransId: String(providerTxnId) })
            const text = await hypFetch(`${baseUrl}?${params.toString()}`)
            const parsed = parseHypResponse(text)
            return parsed // { Token, Tokef, CCode }
        })
    }

    async function capture({ order, amount, payments }) {
        const captureAmount = amount ?? order.finalSumWithShipping
        const chargePayments = normalizeChargePayments(payments ?? order.payment?.payments)
        return logged('capture', { orderNumber: order.number, amount: captureAmount, payments: chargePayments }, async () => {
            const { masof, passp, baseUrl } = getConfig()
            const p = order.payment || {}
            const authorizedAmount = p.authorizedAmount
            if (!p.cardToken || !p.cardExpiry) throw { status: 400, message: 'Missing card token for capture' }
            if (!p.authCode) throw { status: 400, message: 'Missing authCode for capture' }
            const { tmonth, tyear } = parseTokef(p.cardExpiry)
            const payerId = p.providerPayerId || '000000000'
            const clientName = decodeEntities(`${order.name?.first || ''} ${order.name?.last || ''}`.trim()) || 'Customer'
            const originalAmountAgorot = Math.round(Number(authorizedAmount) * 100)
            const providerUid = p.providerUid

            const params = new URLSearchParams()
            params.set('action', 'soft')
            params.set('UTF8', 'True')
            params.set('Masof', masof)
            params.set('PassP', passp)
            params.set('UserId', payerId)
            params.set('ClientName', clientName)
            params.set('Token', 'True')
            params.set('CC', p.cardToken)
            params.set('Tmonth', tmonth)
            params.set('Tyear', tyear)
            params.set('AuthNum', p.authCode)
            params.set('Amount', String(captureAmount))
            params.set('inputObj.originalAmount', String(originalAmountAgorot))
            params.set('inputObj.originalUid', String(providerUid || ''))
            params.set('inputObj.authorizationCodeManpik', '7')
            if (order.id) params.set('Info', order.id)
            applyChargeInstallments(params, chargePayments)

            const text = await hypFetch(`${baseUrl}?${params.toString()}`)
            const parsed = parseHypResponse(text)
            return parsed // { Id, CCode, ... }
        })
    }

    async function chargeToken({ order, amount, payments }) {
        // immediate token charge, no J4 refs (no originalUid/originalAmount)
        // used for over-capture overflow and post-capture delta
        const chargePayments = normalizeChargePayments(payments ?? order.payment?.payments)
        return logged('chargeToken', { orderNumber: order.number, amount, payments: chargePayments }, async () => {
            const { masof, passp, baseUrl } = getConfig()
            const p = order.payment || {}
            if (!p.cardToken || !p.cardExpiry) throw { status: 400, message: 'Missing card token for charge' }
            const { tmonth, tyear } = parseTokef(p.cardExpiry)
            const payerId = p.providerPayerId || '000000000'
            const clientName = decodeEntities(`${order.name?.first || ''} ${order.name?.last || ''}`.trim()) || 'Customer'
            const params = new URLSearchParams()
            params.set('action', 'soft')
            params.set('Masof', masof)
            params.set('PassP', passp)
            params.set('UserId', payerId)
            params.set('ClientName', clientName)
            params.set('Token', 'True')
            params.set('CC', p.cardToken)
            params.set('Tmonth', tmonth)
            params.set('Tyear', tyear)
            params.set('Amount', String(amount))
            if (order.id) params.set('Info', order.id)
            applyChargeInstallments(params, chargePayments)
            const text = await hypFetch(`${baseUrl}?${params.toString()}`)
            const parsed = parseHypResponse(text)
            return parsed // { Id, CCode, ... }
        })
    }

    async function captureOverCaptureSplit({ order, captureAmount, payments }) {
        // fallback when J4 > authorized and over-capture not allowed: capture max + token charge remainder
        const authorized = order.payment.authorizedAmount
        const overflow = Number((captureAmount - authorized).toFixed(2))
        if (overflow <= 0) return { primary: await capture({ order, amount: captureAmount, payments }) }
        const primary = await capture({ order, amount: authorized, payments })
        if (primary.CCode !== 0) return { primary }
        const secondary = await chargeToken({ order, amount: overflow, payments })
        return { primary, secondary, overflow }
    }

    async function refund({ providerTxnId, amount }) {
        return logged('refund', { TransId: String(providerTxnId), Amount: String(amount) }, async () => {
            const { masof, passp, baseUrl } = getConfig()
            const params = new URLSearchParams({ action: 'zikoyAPI', Masof: masof, PassP: passp, TransId: String(providerTxnId), Amount: String(amount) })
            const text = await hypFetch(`${baseUrl}?${params.toString()}`)
            const parsed = parseHypResponse(text)
            return parsed // { Id (new), CCode }
        })
    }

    async function cancel({ providerTxnId }) {
        return logged('cancel', { TransId: String(providerTxnId) }, async () => {
            const { masof, passp, baseUrl } = getConfig()
            const params = new URLSearchParams({ action: 'CancelTrans', Masof: masof, PassP: passp, TransId: String(providerTxnId) })
            const text = await hypFetch(`${baseUrl}?${params.toString()}`)
            const parsed = parseHypResponse(text)
            return parsed // { ReversalStatus, CCode }
        })
    }

    async function invoiceLink(providerTxnId) {
        return logged('invoiceLink', { TransId: String(providerTxnId) }, async () => {
            const { masof, key, passp, baseUrl } = getConfig()
            const params = new URLSearchParams({ action: 'APISign', What: 'SIGN', Masof: masof, KEY: key, PassP: passp, TransId: String(providerTxnId), type: 'EZCOUNT', ACTION: 'PrintHesh' })
            const text = await hypFetch(`${baseUrl}?${params.toString()}`)
            const trimmed = text.trim()
            if (!trimmed || trimmed.includes('CCode') && trimmed.includes('Error')) {
                const parsed = parseHypResponse(trimmed)
                if (parsed.CCode && parsed.CCode !== 0) throw { status: 502, message: `PrintHesh failed: ${CCODE_MESSAGES[parsed.CCode] || parsed.CCode}`, providerCode: parsed.CCode }
            }
            return `${baseUrl}?${trimmed}`
        })
    }

    function ccodeMessage(code) {
        return CCODE_MESSAGES[code] || `Hyp error ${code}`
    }

    function cardBrandName(brand) {
        const idx = Number(brand)
        if (Number.isNaN(idx)) return undefined
        return CARD_COMPANIES[idx] || undefined
    }

    return {
        getConfig,
        parseHypResponse,
        parseTokef,
        createPaymentUrl,
        verifyRedirect,
        getToken,
        capture,
        captureOverCaptureSplit,
        chargeToken,
        refund,
        cancel,
        invoiceLink,
        ccodeMessage,
        cardBrandName
    }
}
