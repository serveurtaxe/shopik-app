import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    VEE_DEFAULT_ACCESS,
    buildVeeArgs,
    resolveVeeConfig,
    veeScriptUrl
} from '../../common/functions/vee.js'

// The production key Vee issued. Tests only ever use it as a string — nothing
// here touches the network, so the value is not a secret in any real sense.
const SITEKEY = '6ba661d9a0b5204898571b794f633fb8'
const PROD = { PROD: true }
const ENABLED = { enabled: 'true', sitekey: SITEKEY }

const settings = (vee, theme) => ({ integrations: { vee }, theme })
const resolve = (vee, env = PROD, theme) => resolveVeeConfig(settings(vee, theme), env)

describe('resolveVeeConfig — production gate', () => {
    it('returns null in every non-production shape', () => {
        assert.equal(resolveVeeConfig(settings(ENABLED)), null)
        assert.equal(resolve(ENABLED, {}), null)
        assert.equal(resolve(ENABLED, { PROD: false }), null)
        // Strict boolean on purpose: the server ships a real boolean, and a
        // string sneaking in must fail closed rather than open the gate.
        assert.equal(resolve(ENABLED, { PROD: 'true' }), null)
        assert.equal(resolve(ENABLED, { PROD: 1 }), null)
    })

    it('returns the config only when PROD is the boolean true', () => {
        assert.ok(resolve(ENABLED))
    })
})

describe('resolveVeeConfig — enabled gate', () => {
    it('returns null when the setting is absent or malformed', () => {
        assert.equal(resolveVeeConfig(undefined, PROD), null)
        assert.equal(resolveVeeConfig({}, PROD), null)
        assert.equal(resolveVeeConfig({ integrations: {} }, PROD), null)
        assert.equal(resolve(null), null)
        assert.equal(resolve(['enabled']), null)
    })

    it('treats every non-truthy enabled flag as off', () => {
        for (const enabled of [undefined, false, 'false', '0', '', 'no', 'on', null]) {
            assert.equal(resolve({ ...ENABLED, enabled }), null, `enabled=${String(enabled)}`)
        }
    })

    // ConfigEditor re-stringifies the whole config on save, so a real boolean
    // only survives until the first admin edit.
    it('accepts the boolean and string forms of enabled', () => {
        for (const enabled of [true, 'true', 1, '1']) {
            assert.ok(resolve({ ...ENABLED, enabled }), `enabled=${String(enabled)}`)
        }
    })
})

describe('resolveVeeConfig — sitekey gate', () => {
    it('returns null for a missing, blank or malformed sitekey', () => {
        for (const sitekey of [undefined, '', '   ', null, 123, {}, SITEKEY.slice(0, 8)])
            assert.equal(resolve({ enabled: 'true', sitekey }), null, `sitekey=${String(sitekey)}`)

        // Anything that could break out of the global object is rejected.
        assert.equal(resolve({ enabled: 'true', sitekey: `${SITEKEY}";alert(1)//` }), null)
        assert.equal(resolve({ enabled: 'true', sitekey: `${SITEKEY} ${SITEKEY}` }), null)
    })

    it('trims the surrounding whitespace', () => {
        assert.equal(resolve({ enabled: 'true', sitekey: `  ${SITEKEY}  ` }).sitekey, SITEKEY)
    })
})

describe('resolveVeeConfig — normalisation', () => {
    it('falls back to the vendor origin for an unusable access value', () => {
        for (const access of [
            undefined, '', 'http://vee-crm.com', 'javascript:alert(1)',
            'https://vee-crm.com/embed', '//vee-crm.com', 'https://'
        ]) {
            assert.equal(resolve({ ...ENABLED, access })?.access, VEE_DEFAULT_ACCESS, `access=${String(access)}`)
        }
    })

    it('keeps a valid https origin and drops its trailing slashes', () => {
        assert.equal(resolve({ ...ENABLED, access: 'https://vee-crm.com/' }).access, 'https://vee-crm.com')
        assert.equal(resolve({ ...ENABLED, access: ' https://staging.vee-crm.com ' }).access, 'https://staging.vee-crm.com')
    })

    it('whitelists position and language', () => {
        assert.equal(resolve({ ...ENABLED, position: 'left' }).position, 'Right')
        assert.equal(resolve({ ...ENABLED, position: 'Left' }).position, 'Left')
        assert.equal(resolve({ ...ENABLED, language: 'en' }).language, 'EN')
        assert.equal(resolve({ ...ENABLED, language: '<script>' }).language, 'HE')
    })

    it('only lets web URLs and internal paths through to the widget links', () => {
        assert.equal(resolve({ ...ENABLED, policyUrl: '/accessibility' }).policyUrl, '/accessibility')
        assert.equal(resolve({ ...ENABLED, policyUrl: 'https://shefa.click/accessibility' }).policyUrl, 'https://shefa.click/accessibility')
        for (const policyUrl of ['javascript:alert(1)', 'data:text/html,x', '//evil.example', 'accessibility'])
            assert.equal(resolve({ ...ENABLED, policyUrl }).policyUrl, '')
    })

    it('filters, dedupes and case-normalises the exclude list', () => {
        assert.deepEqual(
            resolve({ ...ENABLED, exclude: 'grayscale, GRAYSCALE,not-a-feature, highlight-links' }).exclude,
            ['grayscale', 'highlight-links']
        )
        assert.deepEqual(resolve({ ...ENABLED, exclude: '' }).exclude, [])
    })

    it('coerces numeric settings and clamps them', () => {
        const config = resolve({
            ...ENABLED,
            iconOffsetTop: '250',
            iconOffsetBottom: 'abc',
            mobileBottomOffset: '100',
            buttonSizeMobile: '5',
            buttonSizeTablet: '9999'
        })
        assert.equal(config.iconOffsetTop, 250)
        assert.equal(config.iconOffsetBottom, 0)
        assert.equal(config.mobileBottomOffset, 100)
        assert.equal(config.buttonSizeMobile, 16)
        assert.equal(config.buttonSizeTablet, 64)
    })

    it('accepts the string forms of the boolean options', () => {
        const config = resolve({ ...ENABLED, aaa: '1', hideMobile: 'true', hideTablet: false })
        assert.equal(config.aaa, true)
        assert.equal(config.hideMobile, true)
        assert.equal(config.hideTablet, false)
    })
})

describe('resolveVeeConfig — colours', () => {
    it('defaults to the vendor palette', () => {
        assert.deepEqual(resolve(ENABLED).colors, {
            primaryColor: '#136ef8',
            secondaryColor: '#b586ff',
            backgroundColor: '#f6f6f6',
            primaryTextColor: '#636363',
            headersTextColor: '#105675',
            highlightFocusColor: '#136ef8'
        })
    })

    it('follows the store brand for the primary colour', () => {
        assert.equal(resolve(ENABLED, PROD, { 'header-bg': '#195855' }).colors.primaryColor, '#195855')
        assert.equal(
            resolve(ENABLED, PROD, { 'header-bg': { light: '#0a0b0c', dark: '#fafafa' } }).colors.primaryColor,
            '#0a0b0c'
        )
    })

    it('lets an explicit colour win and ignores an invalid one', () => {
        assert.equal(resolve({ ...ENABLED, primaryColor: '#123456' }, PROD, { 'header-bg': '#195855' }).colors.primaryColor, '#123456')
        assert.equal(resolve({ ...ENABLED, primaryColor: 'red' }).colors.primaryColor, '#136ef8')
        assert.equal(resolve(ENABLED, PROD, { 'header-bg': 'not-a-colour' }).colors.primaryColor, '#136ef8')
    })
})

describe('buildVeeArgs', () => {
    it('returns null without a config', () => {
        assert.equal(buildVeeArgs(null), null)
        assert.equal(buildVeeArgs({}), null)
    })

    it('mirrors the vendor snippet shape key for key', () => {
        assert.deepEqual(buildVeeArgs(resolve(ENABLED)), {
            sitekey: SITEKEY,
            position: 'Right',
            language: 'HE',
            container: '',
            access: 'https://vee-crm.com',
            styles: {
                primary_color: '#136ef8',
                secondary_color: '#b586ff',
                background_color: '#f6f6f6',
                primary_text_color: '#636363',
                headers_text_color: '#105675',
                primary_font_size: 14,
                slider_left_color: '#b586ff',
                slider_right_color: '#136ef8',
                icon_vertical_position: 'bottom',
                icon_offset_top: 100,
                icon_offset_bottom: 0,
                highlight_focus_color: '#136ef8'
            },
            links: {},
            options: {
                open: false,
                aaa: false,
                hide_tablet: false,
                hide_mobile: false,
                button_size_tablet: 40,
                button_size_mobile: 27,
                position_tablet: 'Right',
                position_mobile: 'Right',
                icon_vertical_position_tablet: 'bottom',
                icon_vertical_position_mobile: 'bottom',
                icon_offset_top_tablet: 100,
                icon_offset_bottom_tablet: 0,
                icon_offset_top_mobile: 0,
                icon_offset_bottom_mobile: 0,
                disable_headings: true
            },
            exclude: []
        })
    })

    it('passes the configured links and excludes through', () => {
        const args = buildVeeArgs(resolve({
            ...ENABLED,
            policyUrl: '/accessibility',
            additionalLink: 'https://vee.co.il/pricing/',
            exclude: 'animations'
        }))
        assert.deepEqual(args.links, {
            acc_policy: '/accessibility',
            additional_link: 'https://vee.co.il/pricing/'
        })
        assert.deepEqual(args.exclude, ['animations'])
    })

    it('omits empty links so the widget never renders a dead entry', () => {
        assert.deepEqual(buildVeeArgs(resolve({ ...ENABLED, policyUrl: 'javascript:alert(1)' })).links, {})
    })
})

describe('veeScriptUrl', () => {
    it('builds the version-less vendor path', () => {
        assert.equal(veeScriptUrl('https://vee-crm.com'), 'https://vee-crm.com/js/')
        assert.equal(veeScriptUrl(), `${VEE_DEFAULT_ACCESS}/js/`)
    })
})
