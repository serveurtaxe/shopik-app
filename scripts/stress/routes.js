// Route discovery mirroring server/router.js: every file under server/api with a
// default-exported function is a live route at <dir-path>/<action>. We import the
// files (no side effects — connections only happen in boot) to read each route's
// config for auth/permission classification.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const API_DIR = path.resolve(import.meta.dirname, '../../server/api')

// Read-only allow-list: last path segment (the action) must match. Everything
// else is only run with an explicit --mutations flag.
const READ_ACTIONS = new Set([
    'read', 'id', 'get', 'search', 'count', 'filters', 'tree', 'options',
    'details', 'list', 'nearby', 'carousel', 'timeline', 'export', 'stats',
    'aliases', 'readById', 'menu', 'sales_window'
])
const READ_SUFFIXES = ['_report', '_check', '_stats']
const READ_PREFIXES = ['suggest_']
// Read-shaped names that are not safe load: sync_* actions write (user/sync_stats
// rebuilds user_stats), bot/* routes reach the external Comax APIs.
const DENY_PREFIXES = ['sync_', 'send_']
const DENY_ROUTE_PREFIXES = ['bot/']
// Auth/infrastructure routes are never part of load, even with --mutations.
const NEVER_RUN = new Set(['login', 'login_otp', 'logout', 'register', 'send', 'resend'])

// Read-shaped routes whose ACTION NAME says nothing (they are only reachable
// through another feature's permissions). Listed one by one, with what they
// really do, because widening READ_ACTIONS instead would silently admit every
// same-named neighbour — including the write ones.
const ALSO_READ = new Set([
    'notifications/counts', // countDocuments per notification source
    'order/mine', // Order.find over the shopper's past orders
    'order/status', // Order.readOne by order number
    'order/ops/pick_limits', // Order.readById + the domain's pick settings
    'user/coupon', // getUserOrder + Coupon.read
    'user/favorites', // the shopper's favorite ids
    'category/products', // Product.read + countDocuments of one Comax sub-group
    'display_block/categories', // Category.read over every category
    'role/children', // Role.readById + Role.read({ parentIds })
    'payment/refunds', // Order.readById + PaymentTransaction.read
    'supply_area/lookup' // $geoIntersects over supply_areas
])

function walk(dir, prefix = '') {
    const out = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name
        if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel))
        else if (entry.isFile() && entry.name.endsWith('.js')) out.push({ file: path.join(dir, entry.name), route: rel.replace(/\.js$/, '') })
    }
    return out
}

export function isReadOnlyRoute(route) {
    const action = route.split('/').pop() || ''
    if (NEVER_RUN.has(action)) return false
    if (DENY_PREFIXES.some(prefix => action.startsWith(prefix))) return false
    if (DENY_ROUTE_PREFIXES.some(prefix => route.startsWith(prefix))) return false
    if (READ_ACTIONS.has(action)) return true
    if (READ_SUFFIXES.some(suffix => action.endsWith(suffix))) return true
    if (READ_PREFIXES.some(prefix => action.startsWith(prefix))) return true
    // The named exceptions beat the heuristics: 'lookup'/'status'/'products' are
    // not read-safe in general, so each one is admitted only by full route name.
    return ALSO_READ.has(route)
}

export async function discoverRoutes({ only = null, mutations = false } = {}) {
    const routes = []
    for (const { file, route } of walk(API_DIR)) {
        let mod
        try {
            mod = await import(pathToFileURL(file).href)
        } catch (err) {
            routes.push({ route, unusable: `import failed: ${err.message}` })
            continue
        }
        const handler = mod.default
        if (typeof handler !== 'function') continue // helper file, the router skips it too
        const config = handler.config || {}
        const readOnly = isReadOnlyRoute(route)
        if (!readOnly && !mutations) continue
        if (NEVER_RUN.has(route.split('/').pop())) continue
        if (only && !new RegExp(only).test(route)) continue
        routes.push({
            route,
            readOnly,
            alsoRead: ALSO_READ.has(route),
            permissions: [].concat(config.permissions || []),
            auth: config.auth || null,
            preventMultiple: Boolean(config.preventMultiple)
        })
    }
    routes.sort((a, b) => a.route.localeCompare(b.route))
    return routes
}
