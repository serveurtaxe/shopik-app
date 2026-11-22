/**
 * Seed the per-domain Vee accessibility-widget settings (idempotent, safe to re-run).
 * Usage:
 *   node server/scripts/runSeed.js seedVeeSetting
 *   node server/scripts/runSeed.js seedVeeSetting <domainId>
 *
 * One public `config` Setting under category 'integrations' / subCategory 'vee',
 * so it renders in Admin -> Settings next to glassix/ezcount and reaches the
 * storefront as settings.integrations.vee. Seeded disabled with an empty
 * sitekey: an admin fills the sitekey from the Vee dashboard, then flips
 * enabled to 'true'.
 *
 * Three gates, all of them in common/functions/vee.js:
 *   1. `enabled`            — opt-in, exactly like glassix/ezcount.
 *   2. `sitekey`            — required; empty means "not configured".
 *   3. production-only      — Vee issued the sitekey for the production domain,
 *                             so the widget never loads in a non-production run.
 *                             A staging domain has its own Setting row: leave the
 *                             sitekey empty there, or keep the key and enabled
 *                             'false' and flip it for a QA window (staging is a
 *                             production build, so the flag alone decides).
 *
 * Colours are seeded empty on purpose: an empty colour falls back to the store
 * theme (theme/colors header-bg) and then to the vendor default, so a store
 * that never touches these rows still gets a launcher in its own palette.
 *
 * Existing keys are never overwritten — edit values in Admin -> Settings.
 *
 * Note for when CSP is tightened (see server/middleware/security.js): the widget
 * needs script-src for the `access` origin, plus frame-src/style-src/img-src/
 * connect-src for what its panel loads from there.
 */
const SETTINGS = [
    {
        key: 'vee',
        value: {
            enabled: 'false',
            // Vee dashboard -> the customer's snippet -> window.args.sitekey.
            sitekey: '',
            access: 'https://vee-crm.com',
            language: 'HE',
            position: 'Right',
            aaa: 'false',
            hideMobile: 'false',
            hideTablet: 'false',
            // Offsets (px) and button sizes keep the launcher clear of the
            // Glassix chat bubble: raise mobileBottomOffset on stores that run
            // both widgets, so the two do not stack in the same corner.
            iconOffsetTop: '100',
            iconOffsetBottom: '0',
            mobileBottomOffset: '0',
            buttonSizeMobile: '27',
            buttonSizeTablet: '40',
            primaryColor: '',
            secondaryColor: '',
            backgroundColor: '',
            primaryTextColor: '',
            headersTextColor: '',
            highlightFocusColor: '',
            // The legally required accessibility statement. An internal path
            // ('/accessibility') or the customer statement page Vee generated.
            policyUrl: '',
            additionalLink: '',
            // Comma separated vendor feature keys to switch off, e.g.
            // 'animations,grayscale' — see EXCLUDE_FEATURES in
            // common/functions/vee.js for the accepted list.
            exclude: ''
        },
        category: 'integrations',
        subCategory: 'vee',
        formType: 'config',
        renderType: 'config',
        public: true,
        hidden: false
    }
]

export default async function seedVeeSetting({ DL }) {
    const domainFilter = process.argv[3]
    const domains = await DL.Domain.read(
        domainFilter ? { id: domainFilter } : {},
        { _id: 0, id: 1, name: 1 },
        { limit: 0 }
    )
    if (!domains?.length) {
        console.log('[vee] no domains found, nothing to seed')
        return
    }

    let created = 0
    for (const domain of domains) {
        for (const setting of SETTINGS) {
            const existing = await DL.Setting.readOne({ domainId: domain.id, key: setting.key })
            if (existing) continue
            await DL.Setting.create({ ...setting, domainId: domain.id })
            created++
            console.log(`[vee] created ${setting.key} for domain ${domain.id}`)
        }
    }
    console.log(`[vee] Done — ${created} created, rest already existed`)
}
