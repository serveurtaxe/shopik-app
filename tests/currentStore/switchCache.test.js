import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import currentStore from '#server/api/admin/current_store.js'

// The ops page's store picker. Switching must write the admin, invalidate the
// cached auth payload the next request reads (getAdmin), and never invalidate a
// store the admin is not allowed to work in.
const fakeDL = ({ storeExists = true, redisStatus = 'ready' } = {}) => {
    const calls = { updates: [], deletes: [] }
    const DL = {
        redis: {
            status: redisStatus,
            del: async (...keys) => { calls.deletes.push(...keys); return keys.length }
        },
        Admin: {
            updateOne: async (filter, update) => { calls.updates.push({ filter, update }) }
        },
        Store: {
            readById: async (id) => storeExists ? { id } : null
        }
    }
    return { DL, calls }
}

const scopedAdmin = { id: 'adm1', storeIds: ['s1'], hasPermission: () => false }
const superAdmin = { id: 'adm2', storeIds: [], isSuperAdmin: true }

describe('admin store switch', () => {
    it('writes the store and drops the cached auth payload', async () => {
        const { DL, calls } = fakeDL()

        const result = await currentStore({ storeId: 's1' }, { DL, _admin: scopedAdmin })

        assert.deepEqual(result, { currentStoreId: 's1' })
        assert.deepEqual(calls.updates, [{ filter: { id: 'adm1' }, update: { currentStoreId: 's1' } }])
        // The next request must not read the old store out of the auth cache.
        assert.deepEqual(calls.deletes, ['admin_auth:adm1'])
    })

    it('refuses a store outside the admin scope before writing anything', async () => {
        const { DL, calls } = fakeDL()

        await assert.rejects(
            () => currentStore({ storeId: 's2' }, { DL, _admin: scopedAdmin }),
            error => error.status === 403
        )
        assert.deepEqual(calls.updates, [])
        assert.deepEqual(calls.deletes, [])
    })

    it('checks existence only for an unrestricted admin', async () => {
        const { DL, calls } = fakeDL({ storeExists: false })

        await assert.rejects(
            () => currentStore({ storeId: 'nope' }, { DL, _admin: superAdmin }),
            error => error.status === 400 && error.message === 'store not found'
        )
        assert.deepEqual(calls.updates, [])

        // A scoped admin's id is already vetted by membership: no store read.
        await assert.rejects(
            () => currentStore({ storeId: 'nope' }, { DL, _admin: scopedAdmin }),
            error => error.status === 403
        )
    })

    it('switches store even when Redis cannot answer', async () => {
        const { DL, calls } = fakeDL({ redisStatus: 'end' })

        const result = await currentStore({ storeId: 's1' }, { DL, _admin: scopedAdmin })

        assert.deepEqual(result, { currentStoreId: 's1' })
        assert.equal(calls.updates.length, 1)
        assert.deepEqual(calls.deletes, [])
    })

    it('requires a storeId', async () => {
        const { DL } = fakeDL()

        await assert.rejects(
            () => currentStore({}, { DL, _admin: scopedAdmin }),
            error => error.status === 400
        )
    })
})
