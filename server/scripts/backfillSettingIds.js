/**
 * Repair settings data (idempotent, safe to re-run).
 * Usage: node server/scripts/runSeed.js backfillSettingIds
 *
 * Settings inserted straight into Mongo bypass the model's uid() default and
 * have no `id`, which makes Admin update/delete fail (both require id).
 * Assigns a fresh id to every such doc and rebuilds the settings hash cache so
 * stale/duplicate entries left by the old add-only seeding are dropped.
 */
import uid from '#common/functions/uid.js'

export default async function backfillSettingIds({ DL }) {
    const Model = DL.Setting.Model

    const missing = await Model.find(
        { $or: [{ id: { $exists: false } }, { id: null }, { id: '' }] },
        { _id: 1, key: 1 }
    ).lean()

    for (const doc of missing) {
        await Model.updateOne({ _id: doc._id }, { $set: { id: uid() } })
        console.log(`[backfillSettingIds] assigned id to "${doc.key}"`)
    }

    if (DL.redis && Model.cache?.add) {
        try {
            await DL.redis.del(Model.cacheName)
            const docs = await Model.find({}, { _id: 0 }).lean()
            await Model.cache.add(docs)
            console.log(`[backfillSettingIds] rebuilt "${Model.cacheName}" cache (${docs.length} docs)`)
        } catch (e) {
            console.log(`[backfillSettingIds] cache rebuild skipped: ${e?.message || e}`)
        }
    }

    console.log(`[backfillSettingIds] Done — ${missing.length} id(s) backfilled`)
}
