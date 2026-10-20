/**
 * Seed public site name setting (idempotent, safe to re-run).
 * Usage: node server/scripts/runSeed.js seedSiteName
 *
 * Stored under category 'appearance' / subCategory 'general' so it is
 * available to the client as settings.appearance.siteName and editable in
 * Admin -> Settings. Existing values are never overwritten.
 */
export default async function seedSiteName({ DL }) {
    const domains = await DL.Domain.read({}, { _id: 0, id: 1, name: 1 }, { limit: 0 })
    if (!domains?.length) {
        console.log('[siteName] no domains found, nothing to seed')
        return
    }

    let created = 0
    for (const domain of domains) {
        const existing = await DL.Setting.readOne({ domainId: domain.id, key: 'siteName' })
        if (existing) continue
        await DL.Setting.create({
            key: 'siteName',
            value: domain.name,
            domainId: domain.id,
            category: 'appearance',
            subCategory: 'general',
            formType: 'text',
            renderType: 'string',
            public: true,
        })
        created++
        console.log(`[siteName] created for domain ${domain.id}`)
    }
    console.log(`[siteName] Done - ${created} created, rest already existed`)
}
