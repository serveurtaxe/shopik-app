/**
 * Seed public per-domain SEO settings (idempotent, safe to re-run).
 * Usage: node server/scripts/runSeed.js seedSeoSettings
 *
 * Stored under category 'seo' / subCategory 'general' so they are available
 * to the client as settings.seo.* (used by common/functions/buildMeta.js for
 * Open Graph / Twitter cards) and editable in Admin -> Settings.
 * Existing values are never overwritten.
 *
 * ogImage is the social-card image — recommend ~1200x630 uploads. It stores a
 * single full-res variant named `l` (`sizes: { l: null }` = convert to webp
 * only, no resize), unlike the standard l/m/s thumbnails where l is capped at
 * 600px. buildMeta asks for `l`, and the upload sets the value to that exact
 * `.webp` file, so Facebook/Twitter get a large card.
 *
 * Rows created before per-setting sizes existed get their `sizes` repaired
 * here: without it a re-upload stays capped at the 600px `l` variant, which
 * is too small for a large link card. Values are never touched, so the
 * current image keeps working until the admin uploads a new one.
 */
export default async function seedSeoSettings({ DL }) {
    const domains = await DL.Domain.read({}, { _id: 0, id: 1, name: 1 }, { limit: 0 })
    if (!domains?.length) {
        console.log('[seo] no domains found, nothing to seed')
        return
    }

    let created = 0
    let normalized = 0
    for (const domain of domains) {
        const rows = [
            { key: 'seoDescription', value: '', formType: 'textarea', renderType: 'string' },
            { key: 'ogImage', value: '', formType: 'image', renderType: 'image', sizes: { l: null } },
            { key: 'ogType', value: 'website', formType: 'text', renderType: 'string' },
            { key: 'twitterCard', value: 'summary_large_image', formType: 'text', renderType: 'string' }
        ]
        for (const row of rows) {
            const existing = await DL.Setting.readOne({ domainId: domain.id, key: row.key })
            if (!existing) {
                await DL.Setting.create({
                    ...row,
                    domainId: domain.id,
                    category: 'seo',
                    subCategory: 'general',
                    public: true,
                })
                created++
                console.log(`[seo] ${row.key} created for domain ${domain.id}`)
                continue
            }
            // Heal ogImage rows that predate per-setting `sizes`: the next
            // upload then keeps the full resolution instead of capping l at
            // 600px. `l` stays the preview size, so the current value keeps
            // working until the admin uploads a new image.
            if (row.key === 'ogImage' && !Object.hasOwn(existing.sizes || {}, 'l')) {
                await DL.Setting.updateOne({ id: existing.id }, { sizes: { l: null } })
                normalized++
                console.log(`[seo] ogImage upgraded for domain ${domain.id} (re-upload to keep full resolution)`)
            }
        }

        // Cleanup: seoTitle duplicated appearance.siteName (used for the card title).
        const staleTitle = await DL.Setting.readOne({ domainId: domain.id, key: 'seoTitle' })
        if (staleTitle) {
            await DL.Setting.deleteOne({ id: staleTitle.id })
            console.log(`[seo] removed duplicate seoTitle for domain ${domain.id} (siteName is the single name setting)`)
        }
    }
    console.log(`[seo] Done - ${created} created, ${normalized} ogImage upgraded, rest already existed`)
}
