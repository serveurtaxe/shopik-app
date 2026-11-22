// "Read-only" classification shared by the stress runner's route discovery and
// the request logger's sampling. Deliberately conservative: anything not
// clearly a read is treated as a mutation, and mutations are always logged.

// Last path segment (the action) must match. Everything else is a mutation,
// unless named below or matched by a suffix/prefix.
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
// Auth/infrastructure routes are never part of load, and are never sampled out
// of the logs.
const NEVER_RUN = new Set(['login', 'login_otp', 'logout', 'register', 'send', 'resend'])
export { NEVER_RUN }

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
export { ALSO_READ }

export function isReadOnlyRoute(route) {
    // The router passes '/order/mine' while the stress runner passes
    // 'order/mine'; normalize so the exact-route exceptions below match both.
    route = String(route ?? '').replace(/^\/+/, '')
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
