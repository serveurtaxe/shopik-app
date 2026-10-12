/**
 * Seed menu color settings (one-off + idempotent, safe to re-run).
 * Usage: node server/scripts/runSeed.js seedMenuColors
 *
 * Creates public COLOR settings under category 'theme' / subCategory 'colors'.
 * entry-server.jsx auto-injects settings.theme entries as :root CSS vars, so
 * keys are kebab-case (e.g. menu-sales-bg -> var(--menu-sales-bg)).
 * Existing keys are never overwritten — edit values in Admin → Settings.
 */
const MENU_COLOR_DEFAULTS = [
    // Departments (Products) pill — filled green
    { key: 'menu-departments-bg', value: '#7fb539' },
    { key: 'menu-departments-border', value: '#70A83E' },
    { key: 'menu-departments-text', value: '#003324' },
    // Sales pill — orange outline
    { key: 'menu-sales-bg', value: '#fff4ec' },
    { key: 'menu-sales-border', value: '#e8823a' },
    { key: 'menu-sales-text', value: '#e8823a' },
    // Home pill — neutral (matches previous default pill style)
    { key: 'menu-home-bg', value: '#ffffff' },
    { key: 'menu-home-border', value: '#dde4e2' },
    { key: 'menu-home-text', value: '#242a28' },
    // Full-screen tint behind the open menu (closes menu on click)
    { key: 'menu-overlay', value: '#00332499' },
    // Dividers inside the mobile menu drawer
    { key: 'menu-divider', value: '#B4D0C7' },
]

export default async function seedMenuColors({ DL }) {
    const domains = await DL.Domain.read({}, { _id: 0, id: 1, name: 1 }, { limit: 0 })
    if (!domains?.length) {
        console.log('[menuColors] no domains found, nothing to seed')
        return
    }

    let created = 0
    for (const domain of domains) {
        for (const { key, value } of MENU_COLOR_DEFAULTS) {
            const existing = await DL.Setting.readOne({ domainId: domain.id, key })
            if (existing) continue
            await DL.Setting.create({
                key,
                value,
                domainId: domain.id,
                category: 'theme',
                subCategory: 'colors',
                formType: 'color',
                renderType: 'color',
                public: true,
            })
            created++
            console.log(`[menuColors] created ${key} for domain ${domain.id}`)
        }
    }
    console.log(`[menuColors] Done — ${created} created, rest already existed`)
}
