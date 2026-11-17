import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acquireLock } from '../../server/utils/cronLock.js'

// Stands in for the `cron_locks` collection: one row per key, and the unique
// index on `key` is what makes "insert only if absent or expired" atomic — a
// live lock answers with E11000 instead of updating anything.
function fakeLockModel(row = null) {
    const state = { row, ops: [] }

    const matches = filter =>
        state.row?.key === filter.key && state.row?.expiresAt < filter.expiresAt?.$lt

    const Model = {
        findOneAndUpdate(filter, update, options) {
            return {
                async lean() {
                    state.ops.push({ filter, update, options })
                    if (state.row && !matches(filter)) {
                        throw Object.assign(new Error('E11000: duplicate key'), { code: 11000 })
                    }
                    state.row = { key: filter.key, ...update.$set }
                    return { ...state.row }
                }
            }
        },
        async deleteOne(filter) {
            state.ops.push({ deleteOne: filter })
            const owned = state.row?.key === filter.key && state.row?.token === filter.token
            if (owned) state.row = null
            return { deletedCount: owned ? 1 : 0 }
        }
    }

    return { Model, state }
}

const secondsFromNow = seconds => new Date(Date.now() + seconds * 1000)

describe('cron lock (mongodb)', () => {
    it('takes the lock when nobody holds it', async () => {
        const { Model, state } = fakeLockModel()
        const release = await acquireLock('nightly-sync:lock', 60, { Model })

        assert.equal(typeof release, 'function')
        assert.equal(state.row.key, 'nightly-sync:lock')
        assert.ok(state.row.token)
        assert.ok(state.row.expiresAt > new Date())
    })

    it('refuses a lock another instance is holding', async () => {
        const { Model } = fakeLockModel({
            key: 'nightly-sync:lock',
            token: 'other-process',
            expiresAt: secondsFromNow(300)
        })

        assert.equal(await acquireLock('nightly-sync:lock', 60, { Model }), null)
    })

    it('takes over an expired lock', async () => {
        const { Model, state } = fakeLockModel({
            key: 'gs1-sync:lock',
            token: 'crashed-process',
            expiresAt: secondsFromNow(-1)
        })

        const release = await acquireLock('gs1-sync:lock', 60, { Model })

        assert.equal(typeof release, 'function')
        assert.notEqual(state.row.token, 'crashed-process')
    })

    it('fails closed when the lock cannot be read', async () => {
        const Model = {
            findOneAndUpdate() {
                return { lean: async () => { throw new Error('mongo down') } }
            }
        }

        assert.equal(await acquireLock('sales-sync:lock', 60, { Model }), null)
    })

    it('releases only its own row', async () => {
        const { Model, state } = fakeLockModel()
        const release = await acquireLock('invoice-retry:lock', 60, { Model })
        const held = { ...state.row }
        await release()

        assert.deepEqual(state.ops.at(-1).deleteOne, { key: held.key, token: held.token })
        assert.equal(state.row, null)
    })

    it('a release failure does not fail the job', async () => {
        const { Model } = fakeLockModel()
        Model.deleteOne = async () => { throw new Error('mongo down') }
        const release = await acquireLock('holiday-seed:lock', 60, { Model })

        await assert.doesNotReject(release())
    })
})
