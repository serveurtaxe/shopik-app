import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import update from '../../server/api/comax_product/update.js'

const STATUS = { ACTIVE: 'active', HIDDEN: 'hidden' }

describe('comax product update', () => {
    it('hides the active product and marks the comax row inactive', async () => {
        const hidden = []
        const updates = []
        const DL = {
            ComaxProduct: {
                readById: async (id, select) => {
                    assert.equal(id, 'c1')
                    assert.deepEqual(select, { _id: 0, barcode: 1 })
                    return { barcode: '123' }
                },
                updateOne: async (filter, update) => {
                    updates.push({ filter, update })
                    return { id: 'c1', active: false }
                }
            },
            Product: {
                constants: { STATUS },
                update: async (filter, update) => {
                    hidden.push({ filter, update })
                    return { modifiedCount: 1 }
                }
            }
        }

        const res = await update({ id: 'c1', active: false }, { DL })

        assert.deepEqual(hidden, [{
            filter: { barcode: '123', status: 'active' },
            update: { status: 'hidden' }
        }])
        assert.deepEqual(updates, [{ filter: { id: 'c1' }, update: { active: false } }])
        assert.equal(res.active, false)
    })

    it('does not hide anything when activating', async () => {
        const DL = {
            ComaxProduct: {
                readById: async () => ({ barcode: '123' }),
                updateOne: async (filter, update) => ({ id: 'c1', active: true })
            },
            Product: {
                constants: { STATUS },
                update: async () => { throw new Error('should not update') }
            }
        }

        const res = await update({ id: 'c1', active: true }, { DL })

        assert.equal(res.active, true)
    })

    it('rejects a missing row', async () => {
        const DL = { ComaxProduct: { readById: async () => null } }

        await assert.rejects(
            async () => update({ id: 'missing', active: false }, { DL }),
            err => err.status === 400
        )
    })

    it('rejects a non-boolean active value', async () => {
        const DL = { ComaxProduct: { readById: async () => ({ barcode: '123' }) } }

        await assert.rejects(
            async () => update({ id: 'c1', active: 'false' }, { DL }),
            err => err.status === 400
        )
    })
})
