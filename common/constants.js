export const ADMIN_TOKEN_EXPIRY_MS = 1000 * 60 * 60 * 24 * 30
export const USER_TOKEN_EXPIRY_MS = 1000 * 60 * 60 * 24 * 30
export const USER_TOKEN_EXPIRY_SHORT_MS = 1000 * 60 * 60 * 24
export const BOT_TOKEN_EXPIRY_MS = 1000 * 60 * 60 * 24
export const ADMIN_TOKEN_COOKIE = 'at'
export const USER_TOKEN_COOKIE = 'ut'

export const GUEST_CART_TOKEN_COOKIE = 'gc'
export const GUEST_CART_TTL_MS = 1000 * 60 * 60 * 24 * 30
export const SUPPORTED_ADMIN_PLATFORMS = [
    'admin',
    'admin_app',
    'admin_mobile'
]

export const CACHE_STRATEGIES = {
    VERSION: 'version',
    HASHSET: 'hashset'
}

export const WINDOWS_PAGE = {
    FOCUS_START_HOUR: 6,
    FOCUS_END_HOUR: 22,
    HOUR_PX: 64,
    MAX_CAPACITY: 100
}

export const SPECIAL_DAY_EREV_START = 13

export const ADDRESS_PROVIDERS = {
    GOVMAP: 'govmap',
    OSM: 'osm',
    GOOGLE: 'google',
    HYBRID: 'hybrid'
}
export const ADDRESS_PROVIDER_CHAIN = {
    [ADDRESS_PROVIDERS.GOVMAP]: [ADDRESS_PROVIDERS.GOVMAP],
    [ADDRESS_PROVIDERS.OSM]: [ADDRESS_PROVIDERS.OSM],
    [ADDRESS_PROVIDERS.GOOGLE]: [ADDRESS_PROVIDERS.GOOGLE],
    [ADDRESS_PROVIDERS.HYBRID]: [ADDRESS_PROVIDERS.GOVMAP, ADDRESS_PROVIDERS.OSM, ADDRESS_PROVIDERS.GOOGLE]
}

export const OPS_PROXIMITY_RADIUS_M = 150
export const OPS_STORE_AUTO_SELECT_M = 100
export const OPS_LOCATION_THROTTLE_MS = 30 * 1000
export const OPS_LOCATION_MIN_MOVE_M = 100
export const OPS_SHIPPING_SMS_TEXT = 'Your order is on the way!'
export const OPS_PICK_HISTORY_ENABLED = true
export const OPS_SHIP_HISTORY_ENABLED = true