// Resolve the per-domain Vee accessibility-widget config.
//
// Stored as a single public `config` Setting (key `vee`, category
// `integrations`, subCategory `vee`) so every domain gets its own
// enabled/sitekey pair and Admin -> Settings renders it like the other
// integration configs (glassix, ezcount). getSettings() ships it to the client
// as settings.integrations.vee.
//
// Two gates, both fail-closed:
//  - Vee issued the sitekey for production only, so the widget never loads in a
//    non-production run. `env.PROD` is the same isProdEnv() the server already
//    uses for SSR, shipped to the browser by getClientData as env.PROD.
//  - `enabled` must be truthy AND the sitekey valid, exactly like glassix, so a
//    half-filled config (an admin mid-setup) never touches vee-crm.com and a
//    store that never opted in never opens a socket to them.
//
// Kept DOM-free on purpose: entry-server.jsx needs it for the head preconnect
// gate and node --test needs it directly.

export const VEE_DEFAULT_ACCESS = 'https://vee-crm.com'

// Version-less path, as the vendor snippet builds it: access + '/js/'.
export const veeScriptUrl = (access = VEE_DEFAULT_ACCESS) => `${access}/js/`

// Admin -> Settings -> ConfigEditor stringifies every config value, so a real
// boolean only survives until the first admin edit. Same set glassix uses.
const TRUTHY = new Set([true, 'true', '1', 1])

const POSITIONS = new Set(['Right', 'Left'])

// 32 chars in the vendor dashboard; the range leaves room for a format change
// without accepting garbage (spaces, quotes, URL fragments) into window.args.
const SITEKEY_RE = /^[A-Za-z0-9-]{16,64}$/

// Values documented in the vendor snippet. 'high-contast' is their spelling;
// the correctly spelled form is accepted too, so a hand-written setting is not
// silently dropped.
const EXCLUDE_FEATURES = new Set([
    'high-contast', 'high-contrast', 'negative', 'grayscale', 'black-white',
    'highlight-links', 'keyboard-navigation', 'text', 'word-spacing',
    'letter-spacing', 'readable-text', 'alt', 'cursor', 'reading',
    'animations', 'highlight-titles'
])

// Vendor defaults, used when the matching setting is empty.
const DEFAULT_COLORS = {
    primaryColor: '#136ef8',
    secondaryColor: '#b586ff',
    backgroundColor: '#f6f6f6',
    primaryTextColor: '#636363',
    headersTextColor: '#105675',
    highlightFocusColor: '#136ef8'
}

const clean = (value) => typeof value === 'string' ? value.trim() : ''
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const isColor = (value) => /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)

function pickColor(value, fallback) {
    const color = clean(value)
    return isColor(color) ? color : fallback
}

// styles.primary_color defaults to the store brand (theme/colors header-bg),
// so the launcher matches the site without any extra admin work. Theme values
// are either plain strings or { light, dark } like entry-server.jsx handles.
function brandColor(settings) {
    const value = settings?.theme?.['header-bg']
    const color = typeof value === 'string' ? value : value?.light
    return isColor(clean(color)) ? clean(color) : ''
}

// https origin only, no path: the vendor script appends '/js/' to it. A typo
// falls back to the vendor origin instead of leaving the store without a
// widget; http:// and javascript: can never pass.
function normalizeAccess(value) {
    const raw = clean(value).replace(/\/+$/, '')
    if (/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(raw)) return raw
    return VEE_DEFAULT_ACCESS
}

function normalizeLanguage(value) {
    const language = clean(value).toUpperCase()
    return /^[A-Z]{2,3}$/.test(language) ? language : 'HE'
}

// Links end up inside the widget's own UI, so only web URLs and internal
// paths are allowed through — never javascript:/data: from a settings value.
function safeUrl(value) {
    const url = clean(value)
    if (/^https?:\/\//i.test(url)) return url
    if (/^\/(?!\/)/.test(url)) return url
    return ''
}

function resolveExclude(value) {
    const text = Array.isArray(value) ? value.join(',') : clean(value)
    const seen = new Set()
    return text
        .split(',')
        .map(feature => feature.trim().toLowerCase())
        .filter(feature => EXCLUDE_FEATURES.has(feature))
        .filter(feature => !seen.has(feature) && seen.add(feature))
}

function toNumber(value, fallback, min = 0, max = 1000) {
    const text = typeof value === 'number' ? String(value) : clean(value)
    if (!text) return fallback
    const number = Number(text)
    if (!Number.isFinite(number)) return fallback
    return Math.min(max, Math.max(min, Math.round(number)))
}

// Returns a normalized config, or null when this domain should not load the
// widget at all. entry-server.jsx uses the same result to decide whether the
// head may preconnect to Vee.
export function resolveVeeConfig(settings, env = {}) {
    // Production-only gate first: outside a production run nothing else matters.
    // Strict boolean on purpose — a string 'true' must not open the gate.
    if (env.PROD !== true) return null

    const config = settings?.integrations?.vee
    if (!isPlainObject(config)) return null
    if (!TRUTHY.has(config.enabled)) return null

    const sitekey = clean(config.sitekey)
    if (!SITEKEY_RE.test(sitekey)) return null

    const brand = brandColor(settings)
    return {
        sitekey,
        access: normalizeAccess(config.access),
        position: POSITIONS.has(clean(config.position)) ? clean(config.position) : 'Right',
        language: normalizeLanguage(config.language),
        policyUrl: safeUrl(config.policyUrl),
        additionalLink: safeUrl(config.additionalLink),
        exclude: resolveExclude(config.exclude),
        aaa: TRUTHY.has(config.aaa),
        hideMobile: TRUTHY.has(config.hideMobile),
        hideTablet: TRUTHY.has(config.hideTablet),
        iconOffsetTop: toNumber(config.iconOffsetTop, 100),
        iconOffsetBottom: toNumber(config.iconOffsetBottom, 0),
        mobileBottomOffset: toNumber(config.mobileBottomOffset, 0),
        buttonSizeMobile: toNumber(config.buttonSizeMobile, 27, 16, 64),
        buttonSizeTablet: toNumber(config.buttonSizeTablet, 40, 16, 64),
        colors: {
            primaryColor: pickColor(config.primaryColor, brand || DEFAULT_COLORS.primaryColor),
            secondaryColor: pickColor(config.secondaryColor, DEFAULT_COLORS.secondaryColor),
            backgroundColor: pickColor(config.backgroundColor, DEFAULT_COLORS.backgroundColor),
            primaryTextColor: pickColor(config.primaryTextColor, DEFAULT_COLORS.primaryTextColor),
            headersTextColor: pickColor(config.headersTextColor, DEFAULT_COLORS.headersTextColor),
            highlightFocusColor: pickColor(config.highlightFocusColor, DEFAULT_COLORS.highlightFocusColor)
        }
    }
}

// The exact window.args shape the vendor snippet expects. Mirrors it key for
// key, so a future Vee change is a diff against their snippet and not a guess.
export function buildVeeArgs(config) {
    if (!config?.sitekey) return null

    const { colors } = config
    const links = {}
    if (config.policyUrl) links.acc_policy = config.policyUrl
    if (config.additionalLink) links.additional_link = config.additionalLink

    return {
        sitekey: config.sitekey,
        position: config.position,
        language: config.language,
        container: '',
        access: config.access,
        styles: {
            primary_color: colors.primaryColor,
            secondary_color: colors.secondaryColor,
            background_color: colors.backgroundColor,
            primary_text_color: colors.primaryTextColor,
            headers_text_color: colors.headersTextColor,
            primary_font_size: 14,
            slider_left_color: colors.secondaryColor,
            slider_right_color: colors.primaryColor,
            icon_vertical_position: 'bottom',
            icon_offset_top: config.iconOffsetTop,
            icon_offset_bottom: config.iconOffsetBottom,
            highlight_focus_color: colors.highlightFocusColor
        },
        links,
        options: {
            open: false,
            aaa: config.aaa,
            // Bottom on every breakpoint (the vendor snippet uses top on tablet,
            // which fights the sticky storefront header).
            hide_tablet: config.hideTablet,
            hide_mobile: config.hideMobile,
            button_size_tablet: config.buttonSizeTablet,
            button_size_mobile: config.buttonSizeMobile,
            position_tablet: config.position,
            position_mobile: config.position,
            icon_vertical_position_tablet: 'bottom',
            icon_vertical_position_mobile: 'bottom',
            icon_offset_top_tablet: config.iconOffsetTop,
            icon_offset_bottom_tablet: config.iconOffsetBottom,
            icon_offset_top_mobile: 0,
            icon_offset_bottom_mobile: config.mobileBottomOffset,
            // Their heading rewriter would mutate the heading order our SSR
            // markup already ships; the vendor snippet disables it too.
            disable_headings: true
        },
        exclude: config.exclude
    }
}
