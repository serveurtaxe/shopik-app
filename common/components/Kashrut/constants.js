// Kashrut stamps: GS1 Rabbinate codes mapped to the store's certificate
// priority table (top = strongest). Codes in a group share one stamp image,
// named after the group's first code (see ./images and getKashrutImage).
//
// Unlisted codes sort after these (strength unknown) and fall back to their
// GS1 display name. Ordering/image slugs can be adjusted here in one place.

export const KASHRUT_RABBINATES = [
    { rank: 1, name: 'בד"ץ העדה החרדית ירושלים', codes: ['67085', '67068', '67245'] },
    { rank: 2, name: 'הרב לנדא – בני ברק', codes: ['67056', '67026'] },
    { rank: 3, name: 'בד"ץ שארית ישראל', codes: ['67160', '67060'] },
    { rank: 4, name: 'בד"ץ מהדרין – הרב אברהם רובין', codes: ['67016'] },
    { rank: 5, name: 'בד"ץ קהילות', codes: ['67238'] },
    { rank: 6, name: 'בד"ץ יורה דעה – הרב שלמה מחפוד', codes: ['67007', '67024', '67209'] },
    { rank: 7, name: 'בד"ץ אגודת ישראל', codes: ['67076'] },
    { rank: 8, name: 'בד"ץ חוג חתם סופר פתח תקווה', codes: ['67110'] },
    { rank: 9, name: 'בד"ץ חוג חתם סופר בני ברק', codes: ['67163', '67159'] },
    { rank: 10, name: 'בד"ץ מחזיקי הדת – בעלזא', codes: ['67072', '67092'] },
    { rank: 11, name: 'בד"ץ בית יוסף', codes: ['67093', '67061'] }
]

// Kosher_Supervision_Type codes → Hebrew food-category label.
export const SUPERVISION_LABELS = {
    183: 'פרווה',
    182: 'חלבי',
    181: 'בשרי',
    184: 'לא כשר',
    180: 'לא רלוונטי'
}

// code → { rank, name, stampCode }
export const KASHRUT_CODE_INDEX = (() => {
    const index = new Map()
    for (const group of KASHRUT_RABBINATES) {
        const stampCode = group.codes[0]
        for (const code of group.codes)
            index.set(String(code), { rank: group.rank, name: group.name, stampCode })
    }
    return index
})()

// Normalize a product.kashrut value. Legacy products stored a plain string, so
// anything other than the expected object shape yields an empty, safe value.
export function normalizeKashrut(kashrut) {
    if (!kashrut || typeof kashrut !== 'object' || Array.isArray(kashrut))
        return { rabbinates: [], supervisionType: '' }
    return {
        rabbinates: Array.isArray(kashrut.rabbinates) ? kashrut.rabbinates : [],
        supervisionType: kashrut.supervisionType ? String(kashrut.supervisionType) : ''
    }
}

// Sorted stamp entries for display, strongest first. Unknown codes sort last
// (stable by source order). `hasImage(stampCode)` optionally restricts the
// result to entries backed by an image; pass no predicate to keep every entry.
export function selectKashrutStamps(kashrut, count = 1, { hasImage } = {}) {
    const { rabbinates } = normalizeKashrut(kashrut)
    const seen = new Set()
    const entries = []

    rabbinates.forEach((raw, i) => {
        const code = raw?.code != null ? String(raw.code).trim() : ''
        if (!code || seen.has(code)) return
        seen.add(code)
        const known = KASHRUT_CODE_INDEX.get(code)
        const rawName = raw?.name != null ? String(raw.name).trim() : ''
        const name = rawName || known?.name || ''
        if (!name && !known) return
        entries.push({
            code,
            name,
            rank: known?.rank ?? Infinity,
            stampCode: known?.stampCode || code,
            order: i
        })
    })

    entries.sort((a, b) => (a.rank - b.rank) || (a.order - b.order))
    const filtered = hasImage ? entries.filter(e => hasImage(e.stampCode)) : entries
    const limit = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : filtered.length
    return filtered.slice(0, limit)
}

export function getSupervisionLabel(kashrut) {
    const { supervisionType } = normalizeKashrut(kashrut)
    return SUPERVISION_LABELS[supervisionType] || ''
}

export default { KASHRUT_RABBINATES, SUPERVISION_LABELS, selectKashrutStamps, getSupervisionLabel }
