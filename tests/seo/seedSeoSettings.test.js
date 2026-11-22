import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import seedSeoSettings from '../../server/scripts/seedSeoSettings.js'

const ROWS = { seoDescription: 's1', ogImage: 's2', ogType: 's3', twitterCard: 's4' }

// Every row exists unless the test overrides it.
function makeDL(overrides = {}) {
    const existing = Object.fromEntries(
        Object.entries(ROWS).map(([key, id]) => [key, { id, value: '' }])
    )
    for (const [key, value] of Object.entries(overrides)) {
        if (value === null) delete existing[key]
        else existing[key] = value
    }
    const calls = { created: [], updated: [], deleted: [] }
    return {
        calls,
        DL: {
            Domain: { read: async () => [{ id: 'd1', name: 'Store' }] },
            Setting: {
                read: async () => [],
                readOne: async ({ key }) => existing[key] || null,
                create: async doc => { calls.created.push(doc) },
                updateOne: async (filter, update) => { calls.updated.push({ filter, update }) },
                deleteOne: async ({ id }) => { calls.deleted.push(id) }
            }
        }
    }
}

describe('seedSeoSettings', () => {
    it('creates missing rows with the full-res ogImage variant', async () => {
        const { DL, calls } = makeDL({ ogImage: null })
        await seedSeoSettings({ DL })
        const created = calls.created.find(row => row.key === 'ogImage')

        assert.deepEqual(created.sizes, { l: null })
        assert.equal(created.public, true)
        assert.equal(calls.updated.length, 0)
    })

    it('upgrades an ogImage row that predates per-setting sizes', async () => {
        const { DL, calls } = makeDL({
            ogImage: { id: 's2', value: 'images/settings/d1/ogImage/v1' }
        })
        await seedSeoSettings({ DL })

        assert.deepEqual(calls.updated, [
            { filter: { id: 's2' }, update: { sizes: { l: null } } }
        ])
    })

    it('leaves an already-upgraded ogImage row untouched', async () => {
        const { DL, calls } = makeDL({
            ogImage: { id: 's2', value: '', sizes: { l: null } }
        })
        await seedSeoSettings({ DL })

        assert.equal(calls.updated.length, 0)
        assert.equal(calls.created.length, 0)
    })
})
