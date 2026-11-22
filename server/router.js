import allPermissions from '#server/utils/auth/permissions.js'
import apiKeyPermissions from '#common/constants/apiKeyPermissions.js'
import resolveDomainId from '#server/utils/resolveDomainId.js'
import pkg from '#package.json' with { type: 'json' }
import uid from '#common/functions/uid.js'
import { acquireRequestLock } from '#server/utils/requestLock.js'
import { isRedisReady } from '#server/utils/redisSafe.js'
import {
    requestLogEnabled,
    shouldLogRequest,
    summarizeLogValue
} from '#server/utils/requestLog.js'

const appVersion = pkg?.version || 'unknown'

// Bodies above this size are logged as `{ omitted: true, bytes }` instead of
// verbatim — see loggedRequestBody below.
export const MAX_LOGGED_BODY_BYTES = 64 * 1024

/**
 * Request bodies worth storing in the Log doc.
 *
 * Base64 upload bodies run to ~10MB, and truncateLogData stringifies the whole
 * body before slicing, so a big body costs a matching string plus the doc.
 * Compressed bodies are omitted too: content-length would understate them.
 */
export function loggedRequestBody(headers, body) {
    const declaredBytes = Number(headers?.['content-length']) || 0
    const encoding = headers?.['content-encoding']
    const encoded = encoding && encoding !== 'identity'
    if (encoded || declaredBytes > MAX_LOGGED_BODY_BYTES)
        return { omitted: true, bytes: declaredBytes, ...(encoded ? { encoding } : {}) }
    return body
}

const allPermissionsHash = [...allPermissions, ...apiKeyPermissions].reduce((acc, curr) => {
    acc[curr] = true
    return acc
}, {})

const apiRoutes = {}
function populateRoutes(api, prefix = '/') {
    for (const [key, value] of Object.entries(api)) {
        if (typeof value === 'function') {
            apiRoutes[prefix + key] = value
        } else if (typeof value === 'object') {
            populateRoutes(value, prefix + key + '/')
        }
    }
}

function validateApi() {
    for (const [key, value] of Object.entries(apiRoutes)) {
        if (value?.config?.permissions?.length) {
            let validPermissions
            if (typeof value?.config?.permissions === 'string') {
                validPermissions = allPermissionsHash[value?.config?.permissions]
            } else if (Array.isArray(value?.config?.permissions)) {
                validPermissions = value.config.permissions.every(
                    permission => allPermissionsHash[permission]
                )
            }
            if (!validPermissions)
                throw new Error(`Invalid permissions for route ${key}`)
        }
    }
}

/**
 * @param {BootData} bootData
 */
export default function router(app, bootData) {
    const { DL, api, utils } = bootData
    populateRoutes(api)
    validateApi()
    app.use('/api', async (req, res, next) => {
        const { headers, body = {}, files, ip } = req
        const platform = utils.getPlatform(req)
        const route = req.path.replace(/^api\/?/, '').replace(/\/$/, '')
        const apiFunction = apiRoutes[route]
        const requestId = uid(16)
        const requestStart = performance.now()
        let actorId,
            actorType,
            actorName,
            logMeta = null,
            logOutcome = null,
            releaseRequestLock,
            info
        try {
            // Domain middleware - storefront traffic always uses the server-resolved
            // domain (Origin/Referer → Domain, else default). Client-supplied domainId
            // is ignored for non-admin traffic to prevent cross-tenant access.
            // Admin traffic keeps explicit domainId (multi-store management);
            // API-key actor domain still wins below.
            if (body && typeof body === 'object' && !Array.isArray(body)) {
                const isAdminPlatform = platform.includes('admin')
                if (isAdminPlatform) {
                    if (body.domainId == null) body.domainId = await resolveDomainId(req, DL)
                } else {
                    body.domainId = await resolveDomainId(req, DL)
                }
            }
            if (requestLogEnabled() && apiFunction?.config?.log !== false) {
                logMeta = {
                    requestId,
                    requestTime: new Date,
                    action: route,
                    ip,
                    userAgent: headers['user-agent'],
                    appVersion,
                    data: {
                        request: {
                            platform,
                            body: loggedRequestBody(headers, body)
                        }
                    }
                }
            }

            if (typeof apiFunction !== 'function') {
                throw {
                    status: 404,
                    message: `Route ${route} Not Found`
                }
            }

            let _admin
            let _user
            let apiKeyActor = null
            try {
                if (utils?.auth?.verifyApiKey) {
                    apiKeyActor = await utils.auth.verifyApiKey(req, bootData)
                }
            } catch (e) {
                throw e
            }
            const { permissions = [], auth } = apiFunction.config || {}

            if (apiKeyActor) {
                // NOTE: route carries a leading slash (e.g. '/api_key/create').
                if (route.startsWith('api_key/') || route.startsWith('/api_key/')) {
                    throw { status: 403, message: 'API keys cannot manage API keys' }
                }
                if (body && typeof body === 'object' && !Array.isArray(body)) {
                    body.domainId = apiKeyActor.domainId
                }
                _admin = apiKeyActor
                actorId = apiKeyActor.id
                actorType = DL.Log.constants.ACTOR.API
                actorName = apiKeyActor.name
                if (permissions.length) {
                    let hasPermission
                    if (typeof permissions === 'string') {
                        hasPermission = _admin.hasPermission(permissions)
                    } else if (Array.isArray(permissions)) {
                        // OR semantics: admin needs at least one of the listed permissions
                        hasPermission = permissions.some(p => _admin.hasPermission(p))
                    }
                    if (!hasPermission)
                        throw { status: 403, message: 'Forbidden' }
                }
            } else {
                const isAdmin = permissions.length || platform.includes('admin')
                if (isAdmin && auth != 'none') {
                    const adminRequired = permissions.length || auth === 'required'
                    try {
                        _admin = await utils.auth.getAdmin(req, bootData)
                        actorId = _admin.id
                        actorType = DL.Log.constants.ACTOR.ADMIN
                        actorName = `${_admin.name?.first ?? ''} ${_admin.name?.last ?? ''}`
                    } catch (e) {
                        if (adminRequired) throw e
                    }

                    if (permissions.length) {
                        let hasPermission
                        if (typeof permissions === 'string') {
                            hasPermission = _admin.hasPermission(permissions)
                        } else if (Array.isArray(permissions)) {
                            hasPermission = permissions.some(p => _admin.hasPermission(p))
                        }
                        if (!hasPermission)
                            throw { status: 403, message: 'Forbidden' }
                    }
                }

                if (!_admin && auth != 'none') {
                    const isAdminRoute = permissions.length || platform.includes('admin')
                    if (!isAdminRoute) {
                        try {
                            _user = await utils.auth.getUser(req, bootData)
                            actorId = _user.id
                            actorType = DL.Log.constants.ACTOR.USER
                            actorName = `${_user?.name?.first ?? ''} ${_user?.name?.last ?? ''}`
                        } catch (e) {
                            if (auth != 'lax') throw e
                        }
                    }
                }
            }
            // Hard guarantee: any route declaring permissions requires an
            // authenticated actor (API key or admin session), even when
            // auth === 'none' (e.g. bot/* endpoints are API-key only).
            if (permissions.length) {
                const actor = apiKeyActor || _admin
                if (!actor) throw { status: 401, message: 'Authentication required' }
                let hasPermission
                if (typeof permissions === 'string') {
                    hasPermission = actor.hasPermission(permissions)
                } else if (Array.isArray(permissions)) {
                    hasPermission = permissions.some(p => actor.hasPermission(p))
                }
                if (!hasPermission) throw { status: 403, message: 'Forbidden' }
            }

            const setCookie = (name, value, exp) => {
                res.cookie(
                    name,
                    value,
                    {
                        httpOnly: true,
                        secure: process.env.PRODUCTION, // only enable in production HTTPS
                        sameSite: 'lax',                // 'strict' for higher CSRF protection
                        path: '/',
                        maxAge: exp
                    }
                )
            }

            const clearCookie = (name) => res.clearCookie(name)

            info = {
                ...bootData,
                platform,
                ip,
                headers,
                cookies: req.cookies,
                files,
                query: req.query,
                res,
                req,
                setCookie,
                clearCookie,
                _admin,
                _user,
            }

            if (apiFunction?.config?.preventMultiple) {
                let lockKey = `lock:${route}`
                if (typeof apiFunction?.config?.preventMultiple === 'function')
                    lockKey += apiFunction?.config?.preventMultiple(body, info)
                releaseRequestLock = await acquireRequestLock({
                    redis: DL.redis,
                    key: lockKey,
                    token: requestId
                })
                if (!releaseRequestLock) {
                    throw { status: 429, message: 'Too Many Requests' }
                }
            }

            // Loose per-IP cap on OTP *issuance* routes only (SMS-cost backstop).
            // Sized for ~30 workers behind one store IP (login + resends ≈ 90
            // per 15 min worst case → 200 gives 2x headroom incl. kiosks).
            // Verify routes rely on the per-token attempts counter instead;
            // bot/* is exempt (single server IP by design, API-key gated).
            // Fail-open when redis is unavailable.
            // NOTE: route carries a leading slash (e.g. '/user/login_otp').
            const AUTH_ROUTE_LIMITS = {
                '/user/login_otp': { max: 200, windowSec: 900 },
                '/user/register': { max: 200, windowSec: 900 },
                '/admin/login_otp': { max: 200, windowSec: 900 }
            }
            const authLimit = AUTH_ROUTE_LIMITS[route]
            if (authLimit && isRedisReady(DL.redis)) {
                try {
                    const rlKey = `rl:${route}:${ip}`
                    const count = await DL.redis.incr(rlKey)
                    if (count === 1) await DL.redis.expire(rlKey, authLimit.windowSec)
                    if (count > authLimit.max) throw { status: 429, message: 'Too Many Requests' }
                } catch (e) {
                    if (e?.status === 429) throw e
                    // fail-open: ignore redis errors
                }
            }

            if (apiFunction.config?.required?.length) {
                const { required } = apiFunction.config
                const requiredIsMissing = required.filter(required => body[required] == undefined || body[required] === '')
                if (requiredIsMissing.length)
                    throw { status: 400, message: `missing required fields [${requiredIsMissing.join(', ')}]` }
            }

            const result = await apiFunction(body, info)
            if (!res.headersSent) {
                const response = {
                    requestId,
                    data: result,
                    status: 200
                }
                logOutcome = { httpStatus: 200, data: result }
                return res.send(response)
            }
        } catch (error) {
            const errorRes = {
                requestId,
                status: error.status || 500,
                message: error.message || error || 'Internal Error',
                ...(process.env.PRODUCTION || !error.stack ? {} : {
                    stack: error.stack
                }),
                missingFields: error.missingFields || undefined,
                // structured error fields (e.g. payment failures) for client display
                code: error.code || undefined,
                providerCode: error.providerCode ?? undefined,
                amount: error.amount ?? undefined,
                authorizedAmount: error.authorizedAmount ?? undefined,
                capturedTotal: error.capturedTotal ?? undefined,
                delta: error.delta ?? undefined,
            }
            logOutcome = { httpStatus: errorRes.status, data: errorRes, isError: true }

            return res.send(errorRes)
        } finally {
            if (apiFunction?.config?.preventMultiple)
                await releaseRequestLock?.()

            // One insert after the response. Nothing awaits it: the client is
            // already served, and the log must never delay or fail the request.
            if (logMeta) {
                const httpStatus = logOutcome?.httpStatus || res.statusCode || 500
                const durationMs = +(performance.now() - requestStart).toFixed(2)
                if (shouldLogRequest({ route, httpStatus, durationMs })) {
                    try {
                        void DL.Log.record({
                            ...logMeta,
                            // Errors and slow/mutation requests are kept in full;
                            // only successful read responses are summarized.
                            status: httpStatus >= 400
                                ? DL.Log.constants.STATUS.ERROR
                                : DL.Log.constants.STATUS.SUCCESS,
                            responseTime: new Date,
                            duration: durationMs,
                            ...(actorId ? {
                                actor: { type: actorType, id: actorId, name: actorName }
                            } : {}),
                            data: {
                                ...logMeta.data,
                                // An error payload is kept verbatim (message, code,
                                // stack); everything else is capped at 4 KB.
                                ...(logOutcome?.data === undefined ? {} : {
                                    response: logOutcome.isError
                                        ? logOutcome.data
                                        : summarizeLogValue(logOutcome.data)
                                })
                            }
                        })
                    } catch { }
                }
            }
        }
    })
}