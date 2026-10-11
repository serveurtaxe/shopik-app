/**
 * Assign display icons to top-level categories (idempotent, safe to re-run).
 * Usage: node server/scripts/runSeedCategoryIcons.js
 *
 * Only sets `icon` where empty — manual overrides are never overwritten.
 * Uses DL wrappers so the Redis HASHSET cache stays in sync, and drops the
 * cached storefront `menu` (60min TTL) so icons show immediately.
 */
const TOP_LEVEL_ICONS = [
    { slug: 'לחם-חלב-ביצים-ומזון-מצונן', icon: 'milk' },
    { slug: 'חומרי-ניקוי-וכביסה', icon: 'spray' },
    { slug: 'מעדניות-ובית-מאפה', icon: 'croissant' },
    { slug: 'עישון', icon: 'cigarette' },
    { slug: 'טריה-בשר-ודגים', icon: 'beef' },
    { slug: 'מכולת-מזון', icon: 'basket' },
    { slug: 'פירות-וירקות', icon: 'apple' },
    { slug: 'תינוקות', icon: 'baby' },
    { slug: 'קפואים', icon: 'snow' },
    { slug: 'טיפוח-הפרט', icon: 'sparkles' },
    { slug: 'חד-פעמי', icon: 'cup' },
]

export default async function seedCategoryIcons({ DL } = {}) {
    if (!DL) {
        console.log('[categoryIcons] DL required — call seedCategoryIcons({ DL }) from boot/cron')
        return
    }

    let set = 0
    for (const { slug, icon } of TOP_LEVEL_ICONS) {
        const updated = await DL.Category.Model.findOneAndUpdate(
            { slug, parentId: null, $or: [{ icon: null }, { icon: '' }, { icon: { $exists: false } }] },
            { $set: { icon } },
            { returnDocument: 'after', projection: { _id: 0 } }
        ).lean()
        if (!updated) continue
        // findOneAndUpdate bypasses the DL wrapper — sync Redis manually
        await DL.Category.cache?.add(updated)
        set++
        console.log(`[categoryIcons] ${slug} -> ${icon}`)
    }
    if (set > 0) await DL.redis?.del('menu')
    console.log(`[categoryIcons] Done — ${set} icons set`)
}
