import mongoose from 'mongoose'
const { Schema } = mongoose

/**
 * One row per cron job: the row existing *is* the lock.
 *
 * `expiresAt` is a TTL index, so a container that was killed mid-job cannot
 * lock its job out until the TTL runs — the row simply disappears (and the
 * acquire query also accepts an expired row, so a lock is available the moment
 * it expires rather than after the TTL monitor sweeps it).
 */
const cronLockSchema = new Schema({
    key: { type: String, required: true, unique: true },
    token: { type: String, required: true },
    expiresAt: { type: Date, required: true }
})

cronLockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export default mongoose.model('CronLock', cronLockSchema, 'cron_locks')
