import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import readFactory from '../../server/dl/cache/read.js'
import { markCachesSuspect, trustCache } from '../../server/dl/cache/reseed.js'
import { CACHE_STRATEGIES } from '../../common/constants.js'

function fakeRedis(docs, pageSize = 10, status = 'ready') {
    const pages = []
    for (let i = 0; i < docs.length; i += pageSize) {
        const page = []
        for (const doc of docs.slice(i, i + pageSize)) page.push(doc.id, JSON.stringify(doc))
        pages.push(page)
    }

    const redis = {
        status,
        calls: 0,
        async hscan() {
            redis.calls++
            const page = pages.shift() || []
            return [pages.length ? String(redis.calls) : '0', page]
        }
    }
    return redis
}

const Model = {
    cacheStrategy: CACHE_STRATEGIES.HASHSET,
    cacheName: 'things',
    filterFields: new Set(['city']),
    processFilter: filter => filter
}

const docsOf = n => Array.from({ length: n }, (_, i) => ({
    id: String(i),
    city: i % 2 ? 'tlv' : 'jer',
    n: n - i
}))

describe('hashset cache read', () => {
    it('pages through the hash with HSCAN instead of HVALS', async () => {
        const redis = fakeRedis(docsOf(25))
        const read = readFactory(redis, Model)

        const rows = await read({}, { _id: 0 })

        assert.equal(rows.length, 25)
        assert.equal(redis.calls, 3)
    })

    it('stops scanning once an unsorted page is full', async () => {
        const redis = fakeRedis(docsOf(100))
        const read = readFactory(redis, Model)

        const rows = await read({}, { _id: 0 }, { limit: 5 })

        assert.equal(rows.length, 5)
        assert.equal(redis.calls, 1)
    })

    it('honours skip without over-reading', async () => {
        const redis = fakeRedis(docsOf(100))
        const read = readFactory(redis, Model)

        const rows = await read({}, { _id: 0 }, { skip: 2, limit: 3 })

        assert.deepEqual(rows.map(r => r.id), ['2', '3', '4'])
        assert.equal(redis.calls, 1)
    })

    it('filters while scanning and returns all matches for limit: 0', async () => {
        const redis = fakeRedis(docsOf(40))
        const read = readFactory(redis, Model)

        const rows = await read({ city: 'tlv' }, { _id: 0 }, { limit: 0 })

        assert.equal(rows.length, 20)
        assert.ok(rows.every(r => r.city === 'tlv'))
    })

    it('sorts every match before slicing', async () => {
        const redis = fakeRedis(docsOf(30))
        const read = readFactory(redis, Model)

        const rows = await read({}, { _id: 0 }, { sort: { n: 1 }, limit: 3 })

        assert.deepEqual(rows.map(r => r.n), [1, 2, 3])
        assert.equal(redis.calls, 3)
    })

    it('returns null when redis is unavailable so the caller falls back to mongo', async () => {
        const redis = fakeRedis(docsOf(5), 10, 'connecting')
        const read = readFactory(redis, Model)

        assert.equal(await read({}), null)
        assert.equal(redis.calls, 0)
    })
})

// A hash nothing has built (recreated Redis VM, Redis was down at boot) is
// indistinguishable from an empty collection, and an empty hash used to answer
// `[]` for categories / stores / settings forever.
describe('hashset cache read after a redis outage', () => {
    // Seeding is what clears the suspicion, so each case gets its own cacheName.
    const seededModel = docs => {
        const Model = {
            cacheStrategy: CACHE_STRATEGIES.HASHSET,
            cacheName: `unseeded_${docs.length}_${Math.random().toString(36).slice(2)}`,
            filterFields: new Set(['city']),
            processFilter: filter => filter,
            seeded: [],
            cache: {
                ready: () => true,
                clear: async () => { },
                add: async batch => { Model.seeded.push(...batch) }
            },
            find: () => ({
                lean: () => ({
                    cursor: () => (async function* () { for (const doc of docs) yield doc })()
                })
            })
        }
        return Model
    }

    // The rebuild is deliberately not awaited by the reader: let it finish.
    const settle = () => new Promise(resolve => setTimeout(resolve, 20))

    it('an empty first page is treated as an unseeded hash, not an empty collection', async () => {
        const Model = seededModel(docsOf(4))
        const redis = fakeRedis([])
        const read = readFactory(redis, Model)

        assert.equal(await read({}, { _id: 0 }), null)
        assert.equal(redis.calls, 1)

        // ...and the hash gets rebuilt in the background for the next reader.
        await settle()
        assert.deepEqual(Model.seeded.map(d => d.id), ['0', '1', '2', '3'])
    })

    it('a hash marked stale is never read at all', async () => {
        markCachesSuspect('test outage')
        const Model = seededModel(docsOf(3))
        const redis = fakeRedis(docsOf(3))
        const read = readFactory(redis, Model)

        assert.equal(await read({}, { _id: 0 }), null)
        assert.equal(redis.calls, 0, 'a stale hash must not serve rows')

        await settle()
        assert.deepEqual(Model.seeded.map(d => d.id), ['0', '1', '2'])

        trustCache(Model)
        assert.deepEqual((await read({}, { _id: 0 })).map(r => r.id), ['0', '1', '2'])
    })

    // A collection that genuinely is empty (a fresh store's geocode_cache) has an
    // empty hash too. Once something has reconciled it with MongoDB, `[]` is the
    // answer — not a reason to fall back and re-seed nothing every 30 seconds.
    it('a verified empty hash answers empty instead of falling back forever', async () => {
        const Model = seededModel([])
        trustCache(Model)
        const redis = fakeRedis([])
        const read = readFactory(redis, Model)

        assert.deepEqual(await read({}, { _id: 0 }), [])
        assert.equal(redis.calls, 1)
        assert.equal(Model.seeded.length, 0)
    })
})
