import crypto from 'node:crypto'
import { urlencoded } from 'express'
import { rateLimit } from 'express-rate-limit'

// Shared-password gate for non-production deployments. It is inert unless
// SITE_GATE_PASSWORD is set, so production (which never sets it) behaves
// exactly as before: every request goes straight through.
//
// The cookie is stateless: `<expiry>.<hmac>`. The HMAC key mixes in a hash of
// the password, so rotating the env var invalidates every issued cookie without
// a session store.

export const GATE_COOKIE = 'shopik_gate'
export const GATE_LOGIN_PATH = '/__gate'
export const GATE_LOGOUT_PATH = '/__gate/logout'
export const GATE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest()

function sign(exp, password, secret) {
    return crypto.createHmac('sha256', secret)
        .update(`${exp}.${sha256(password).toString('hex')}`)
        .digest('base64url')
}

function sameSecret(a, b) {
    const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a))
    const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b))
    return left.length === right.length && crypto.timingSafeEqual(left, right)
}

export function createGateToken({ password, secret, ttlMs = GATE_MAX_AGE_MS, now = Date.now() }) {
    const exp = now + ttlMs
    return `${exp}.${sign(exp, password, secret)}`
}

export function isGateTokenValid(token, { password, secret, now = Date.now() }) {
    if (typeof token !== 'string') return false
    const parts = token.split('.')
    if (parts.length !== 2) return false
    const [rawExp, signature] = parts
    const exp = Number(rawExp)
    if (!Number.isSafeInteger(exp) || exp <= now) return false
    return sameSecret(signature, sign(exp, password, secret))
}

// GATE_LINKS format: "label|url,label|url" — the real sites this env points at.
export function parseGateLinks(raw) {
    if (!raw) return []
    return String(raw)
        .split(',')
        .map(entry => entry.split('|').map(part => part.trim()))
        .filter(([label, url]) => label && url && /^https?:\/\/\S+$/i.test(url))
        .map(([label, url]) => ({ label, url }))
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => HTML_ESCAPES[ch])

// Local paths only: "//evil.example" and "/\evil.example" are protocol-relative.
function safeNextPath(value) {
    const raw = typeof value === 'string' ? value : ''
    return /^\/(?![/\\])/.test(raw) ? raw : '/'
}

const isApiPath = path => path === '/api' || path.startsWith('/api/')

// Payment-provider callbacks run inside the customer's payment iframe: the
// provider (Hyp) redirects the iframe from its own domain back to us, and a
// cross-site iframe never carries the SameSite=Lax gate cookie. Gating the
// callback would answer 401 before the handler runs, leaving the order in
// 'cart' while the customer sees the paid page. The handler is safe without
// the gate: it verifies every redirect against Hyp's own signature
// (What=VERIFY) before touching anything.
export const GATE_EXEMPT_PATHS = new Set(['/api/payment/hyp/callback'])

// PRODUCTION is a string, so a literal "false" would still be truthy and would
// mark the cookie Secure over plain http://localhost — an endless login loop.
const isHttpsDeployment = () => {
    const prod = process.env.PRODUCTION
    return Boolean(prod) && prod !== 'false'
}

function renderLogin(res, { status, next, error, links }) {
    const errorHtml = error ? `<p class="error">${escapeHtml(error)}</p>` : ''
    const linksHtml = links.length
        ? `<nav>${links
            .map(({ label, url }) => `<a href="${escapeHtml(url)}" rel="noopener">${escapeHtml(label)}</a>`)
            .join('')}</nav>`
        : ''

    res.status(status)
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('X-Robots-Tag', 'noindex, nofollow')
    return res.end(`<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<link rel="icon" href="data:,">
<title>סביבת בדיקה</title>
<style>
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#f4f7f6;color:#1b2422;font-family:system-ui,-apple-system,"Segoe UI",Arial,sans-serif}
.card{width:100%;max-width:360px;background:#fff;border:1px solid #e2e9e7;border-radius:16px;padding:28px 24px;box-shadow:0 8px 24px rgba(25,88,85,.08)}
h1{margin:0 0 4px;font-size:20px}
p{margin:0 0 20px;color:#65716e;font-size:14px}
input{width:100%;padding:12px 14px;font-size:16px;border:1px solid #cbd6d3;border-radius:10px;background:#fff;color:inherit}
input:focus{outline:none;border-color:#195855;box-shadow:0 0 0 3px rgba(25,88,85,.12)}
button{margin-top:12px;width:100%;padding:12px;font-size:16px;font-weight:600;color:#fff;background:#195855;border:0;border-radius:10px;cursor:pointer}
.error{margin:12px 0 0;color:#b42318;font-size:14px}
nav{margin-top:22px;padding-top:18px;border-top:1px solid #edf2f0;display:grid;gap:8px}
nav a{color:#195855;text-decoration:none;font-size:14px}
nav a:hover{text-decoration:underline}
</style>
</head>
<body>
<main class="card">
<h1>סביבת בדיקה</h1>
<p>הזינו סיסמה כדי להמשיך</p>
<form method="post" action="${GATE_LOGIN_PATH}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<input type="password" name="password" autocomplete="current-password" autofocus required aria-label="סיסמה">
<button type="submit">כניסה</button>
</form>
${errorHtml}
${linksHtml}
</main>
</body>
</html>`)
}

export default function createGate({
    password = process.env.SITE_GATE_PASSWORD,
    secret = process.env.SECRET,
    links = process.env.GATE_LINKS
} = {}) {
    if (!password) return function disabled(req, res, next) { next() }

    const siteLinks = parseGateLinks(links)
    // The gate runs before the app's body parsers, so the login form gets its
    // own 1kb urlencoded parser and nothing else is buffered unauthenticated.
    const loginBody = urlencoded({ extended: false, limit: '1kb' })
    const loginLimiter = rateLimit({
        windowMs: 60_000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false
    })

    function handleLogin(req, res) {
        const nextPath = safeNextPath(req.body?.next)
        const submitted = req.body?.password
        const matches = typeof submitted === 'string' && sameSecret(sha256(submitted), sha256(password))
        if (!matches) {
            return renderLogin(res, { status: 401, next: nextPath, error: 'סיסמה שגויה', links: siteLinks })
        }
        res.cookie(GATE_COOKIE, createGateToken({ password, secret }), {
            httpOnly: true,
            secure: isHttpsDeployment(),
            sameSite: 'lax',
            path: '/',
            maxAge: GATE_MAX_AGE_MS
        })
        return res.redirect(303, nextPath)
    }

    return function gate(req, res, next) {
        // CORS preflights carry no cookies by design; CORS itself is the control.
        if (req.method === 'OPTIONS') return next()

        const path = req.path
        const exemptPath = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
        if (GATE_EXEMPT_PATHS.has(exemptPath)) return next()

        if (path === GATE_LOGOUT_PATH) {
            res.clearCookie(GATE_COOKIE, { path: '/' })
            return res.redirect(303, GATE_LOGIN_PATH)
        }

        if (path === GATE_LOGIN_PATH) {
            if (req.method === 'GET' || req.method === 'HEAD') {
                return renderLogin(res, { status: 200, next: safeNextPath(req.query.next), links: siteLinks })
            }
            if (req.method !== 'POST') return res.status(405).end()
            return loginLimiter(req, res, () => loginBody(req, res, () => handleLogin(req, res)))
        }

        if (isGateTokenValid(req.cookies?.[GATE_COOKIE], { password, secret })) return next()

        if (isApiPath(path)) {
            res.setHeader('X-Robots-Tag', 'noindex, nofollow')
            return res.status(401).json({ error: 'unauthorized' })
        }

        return renderLogin(res, { status: 401, next: safeNextPath(req.originalUrl), links: siteLinks })
    }
}
