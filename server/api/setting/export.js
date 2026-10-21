export default async function exp(payload, { DL }) {
    const { category, subCategory, domainId } = payload || {}

    // ponytail: frontend always sends explicit domainId (domain picker); the
    // router resolves one for storefront callers, so an omitted domainId here
    // means unscoped export
    const filter = {}
    if (category) filter.category = String(category).toLowerCase()
    if (subCategory) filter.subCategory = String(subCategory).toLowerCase()
    if (domainId) filter.domainId = domainId

    // DL.Setting.read auto-decrypts config values, so the file holds plaintext
    const docs = await DL.Setting.read(filter, { _id: 0 }, { limit: 0 })

    return {
        exportedAt: new Date().toISOString(),
        scope: {
            category: filter.category || null,
            subCategory: filter.subCategory || null,
            domainId: filter.domainId || null
        },
        // ponytail: entries carry no domainId — the import target domain comes
        // from the domain picker, so files move cleanly between domains
        settings: (docs || []).map((s) => ({
            key: s.key,
            value: s.value,
            category: s.category,
            subCategory: s.subCategory,
            formType: s.formType,
            renderType: s.renderType,
            public: s.public,
            hidden: !!s.hidden
        }))
    }
}

exp.config = {
    permissions: ['setting:read']
}
