// Nutrition indicators, two independent sources:
//
// 1. Diet icons (line icons) ← product.diet, normalized from GS1
//    Diet_Information ({ code, name }). Codes map to a Lucide icon in
//    DIET_GROUPS; code-less claims fall back to a Hebrew name rule. Shown on
//    the card and the product page.
// 2. Food-symbol stamps (colored circles, images) ← product.nutrients, mapped
//    from GS1 Food_Symbol_Red (FSR2/3/4 red, FSR5 green). Product page only —
//    the images live in ./images and are read via getFoodSymbolImage.
//
// Icon choices, ordering and the code/name tables are meant to be edited here.

export const DIET_GROUPS = [
    { key: 'leaf', rank: 1, icon: 'leaf', label: 'אורגני', codes: ['5510', '5511'] },
    { key: 'candyOff', rank: 2, icon: 'candyOff', label: 'ללא סוכר', codes: ['5571', '5503', '5529'] },
    { key: 'grains', rank: 3, icon: 'wheatOff', label: 'ללא דגנים', codes: ['5577'] },
    { key: 'milkOff', rank: 4, icon: 'milkOff', label: 'ללא לקטוז', codes: ['5515', '5537', '5591'] },
    { key: 'salad', rank: 5, icon: 'salad', label: 'צמחוני', codes: ['5501'] },
    { key: 'vegan', rank: 6, icon: 'vegan', label: 'טבעוני', codes: ['5521', '5573'] },
    { key: 'drumstick', rank: 7, icon: 'drumstick', label: 'מכיל חלבון', codes: ['5534'] },
    { key: 'gluten', rank: 8, icon: 'wheatOff', label: 'ללא גלוטן', codes: ['5538', '5502'] }
]

// code → group
export const DIET_CODE_INDEX = (() => {
    const index = new Map()
    for (const group of DIET_GROUPS)
        for (const code of group.codes)
            index.set(String(code), group)
    return index
})()

// Fallback for code-less GS1 entries (value only). First match wins; keep the
// most specific patterns above the generic ones.
export const DIET_NAME_RULES = [
    { key: 'gluten', match: /גלוטן/ },
    { key: 'vegan', match: /טבעוני|ויגן/ },
    { key: 'salad', match: /צמחוני/ },
    { key: 'drumstick', match: /חלבון/ },
    { key: 'milkOff', match: /לקטוז/ },
    { key: 'leaf', match: /אורגני|אקולוגי/ },
    { key: 'grains', match: /דגנים|קמח/ },
    { key: 'candyOff', match: /סוכר/ }
]

export function normalizeDiet(diet) {
    return Array.isArray(diet) ? diet : []
}

function resolveGroup(entry) {
    const code = entry?.code != null ? String(entry.code).trim() : ''
    if (code && DIET_CODE_INDEX.has(code)) return DIET_CODE_INDEX.get(code)
    const name = entry?.name != null ? String(entry.name).trim() : ''
    if (name) {
        const rule = DIET_NAME_RULES.find(r => r.match.test(name))
        if (rule) return DIET_GROUPS.find(g => g.key === rule.key)
    }
    return null
}

// Diet icon entries for display, strongest (lowest rank) first, one icon per
// group. Unknown/legacy values are skipped.
export function selectDietIcons(diet, count = 2) {
    const seen = new Set()
    const entries = []
    normalizeDiet(diet).forEach((raw, order) => {
        const group = resolveGroup(raw)
        if (!group || seen.has(group.icon)) return
        seen.add(group.icon)
        entries.push({ key: group.key, icon: group.icon, label: group.label, rank: group.rank, order })
    })
    entries.sort((a, b) => (a.rank - b.rank) || (a.order - b.order))
    const limit = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : entries.length
    return entries.slice(0, limit)
}

// product.nutrients flags → food-symbol stamps (images). Green symbol first,
// then the red "high in" labels. Order drives display.
export const FOOD_SYMBOLS = [
    { key: 'positive', code: 'FSR5', label: 'סמל ירוק', tone: 'green' },
    { key: 'sodium', code: 'FSR2', label: 'נתרן בכמות גבוהה', tone: 'red' },
    { key: 'sugar', code: 'FSR3', label: 'סוכר בכמות גבוהה', tone: 'red' },
    { key: 'fat', code: 'FSR4', label: 'שומן רווי בכמות גבוהה', tone: 'red' }
]

export function selectFoodSymbols(nutrients) {
    if (!nutrients || typeof nutrients !== 'object') return []
    return FOOD_SYMBOLS.filter(s => nutrients[s.key])
}

export default {
    DIET_GROUPS,
    FOOD_SYMBOLS,
    selectDietIcons,
    selectFoodSymbols
}
