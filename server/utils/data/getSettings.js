export default async function getSettings({ DL, domainId }) {
    // Multi-tenant scoping: when the request domain is known, only return
    // that domain's settings so Store B config never leaks to Store A.
    // Falls back to unfiltered (legacy single-tenant) when unknown.
    const filter = domainId
        ? { active: true, public: true, domainId }
        : { active: true, public: true }
    const settings = await DL.Setting.read(
        filter,
        { _id: 0 },
        { limit: 0 }
    )
    const settingsTree = settings.reduce((acc, s) => {
        if (!acc[s.category]) acc[s.category] = {}
        acc[s.category][s.key] = s.value
        // Uploaded raster sizes, keyed "category.key". Kept outside the
        // category tree so setting values keep their string/object shape.
        if (s.width && s.height) {
            if (!acc.__imageSize) acc.__imageSize = {}
            acc.__imageSize[`${s.category}.${s.key}`] = { width: s.width, height: s.height }
        }
        return acc
    }, {})
    return settingsTree
}