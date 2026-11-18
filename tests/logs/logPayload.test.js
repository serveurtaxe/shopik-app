import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import read from '#server/api/log/read.js'
import readById from '#server/api/log/id.js'

// A prod log document averages ~14.9KB and `data` (the request/response
// snapshot) is nearly all of it. The Logs table renders seven small columns, so
// the list must not ship `data`; log/id is what opens it.
const fullDoc = {
    id: 'a1',
    action: '/user/login',
    requestId: 'r1',
    duration: 12.5,
    createdAt: new Date('2026-11-17T10:00:00.000Z'),
    data: { request: { body: { idNum: '1' } }, response: { data: true } }
}

function fakeDL(calls) {
    return {
        Log: {
            read: async (filter, select, options) => {
                calls.read = { filter, select, options }
                const { _id: dropId, data } = select || {}
                const row = { ...fullDoc }
                if (dropId === 0) delete row._id
                if (data === 0) delete row.data
                return [row]
            },
            readById: async (id) => {
                calls.byId = id
                return { ...fullDoc }
            }
        }
    }
}

describe('log read payload', () => {
    it('ships the list without the data snapshot', async () => {
        const calls = {}
        const [row] = await read({ limit: 30 }, { DL: fakeDL(calls) })

        assert.deepEqual(calls.read.select, { _id: 0, data: 0 })
        assert.equal(row.data, undefined)
        // Everything the table and the row modal's metadata grid render is kept.
        assert.ok(row.action && row.requestId && row.duration && row.createdAt)
    })

    it('keeps pagination and filters on the lean read', async () => {
        const calls = {}
        await read({ filter: { status: 'error' }, limit: 30, skip: 30, sort: { createdAt: -1 } }, { DL: fakeDL(calls) })

        assert.deepEqual(calls.read.filter, { status: 'error' })
        assert.equal(calls.read.options.limit, 30)
        assert.equal(calls.read.options.skip, 30)
        assert.deepEqual(calls.read.options.sort, { createdAt: -1 })
    })

    it('honours an explicit select instead of the lean default', async () => {
        const calls = {}
        await read({ limit: 30, select: { action: 1 } }, { DL: fakeDL(calls) })

        assert.deepEqual(calls.read.select, { action: 1 })
    })

    it('log/id returns the document with its data', async () => {
        const calls = {}
        const doc = await readById({ id: 'a1' }, { DL: fakeDL(calls) })

        assert.equal(calls.byId, 'a1')
        assert.deepEqual(doc.data.request.body, { idNum: '1' })
        assert.ok(readById.config.required.includes('id'))
    })

    it('neither route writes a log for reading logs', () => {
        assert.equal(read.config.log, false)
        assert.equal(readById.config.log, false)
    })
})
