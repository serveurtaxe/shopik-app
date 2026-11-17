import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Read before importing: the reseed rate limit is resolved at module load.
process.env.CACHE_RESEED_MIN_MS = '1'
const reseedInBackground = (await import('../../server/dl/cache/reseed.js')).default
const { hasVerifiedCache, isCacheSuspect, markCachesSuspect, trustCache } =
    await import('../../server/dl/cache/reseed.js')
const { CACHE_STRATEGIES } = await import('../../common/constants.js')

function fakeModel(docs, { ready = true } = {}) {
    const Model = {
        modelName: 'Thing',
        cacheStrategy: CACHE_STRATEGIES.HASHSET,
        cacheName: `things_${docs.length}_${Math.random().toString(36).slice(2)}`,
        cache: {
            ready: () => ready,
            cleared: 0,
            batches: [],
            clear: async () => { Model.cache.cleared++ },
            add: async batch => { Model.cache.batches.push(batch) }
        },
        find: () => ({
            lean: () => ({
                cursor: () => (async function* () {
                    for (const doc of docs) yield doc
                })()
            })
        })
    }
    return Model
}

const docsOf = n => Array.from({ length: n }, (_, i) => ({ id: String(i) }))

describe('cache reseed', () => {
    it('a cache is trusted until something invalidates it', () => {
        const Model = fakeModel(docsOf(3))
        assert.equal(isCacheSuspect(Model), false)

        markCachesSuspect('test')
        assert.equal(isCacheSuspect(Model), true)

        trustCache(Model)
        assert.equal(isCacheSuspect(Model), false)
    })

    it('a hash this process never reconciled is not "verified"', () => {
        const Model = fakeModel(docsOf(2))
        assert.equal(hasVerifiedCache(Model), false)

        trustCache(Model)
        assert.equal(hasVerifiedCache(Model), true)

        markCachesSuspect('test')
        assert.equal(hasVerifiedCache(Model), false)
    })

    it('rebuilds the hash from mongo and stops suspecting it', async () => {
        const Model = fakeModel(docsOf(7))
        markCachesSuspect('test')

        await reseedInBackground(Model)

        assert.equal(Model.cache.cleared, 1, 'stale contents are dropped first')
        assert.deepEqual(Model.cache.batches.flat().map(d => d.id), ['0', '1', '2', '3', '4', '5', '6'])
        assert.equal(isCacheSuspect(Model), false)
    })

    it('concurrent readers share one rebuild', async () => {
        const Model = fakeModel(docsOf(5))
        markCachesSuspect('test')

        const first = reseedInBackground(Model)
        const second = reseedInBackground(Model)

        assert.equal(first, second)
        await first
        assert.equal(Model.cache.batches.length, 1)
    })

    // `cache.add` is a no-op while redis is down, so a "successful" seed can
    // still have written nothing: trusting that hash is the original bug.
    it('does not rebuild into a redis that cannot be written to', async () => {
        const Model = fakeModel(docsOf(4), { ready: false })
        markCachesSuspect('test')

        assert.equal(reseedInBackground(Model), null)
        assert.equal(Model.cache.batches.length, 0)
        assert.equal(isCacheSuspect(Model), true)
    })

    it('does not trust a rebuild that lost redis halfway through', async () => {
        const Model = fakeModel(docsOf(4))
        let ready = true
        Model.cache.ready = () => ready
        Model.cache.add = async batch => {
            Model.cache.batches.push(batch)
            ready = false // redis dropped mid-stream
        }
        markCachesSuspect('test')

        await reseedInBackground(Model)

        assert.equal(Model.cache.batches.length, 1)
        assert.equal(isCacheSuspect(Model), true)
    })

    it('a failed rebuild leaves the cache suspect for the next reader', async () => {
        const Model = fakeModel(docsOf(2))
        Model.find = () => { throw new Error('mongo down') }
        markCachesSuspect('test')

        await reseedInBackground(Model)

        assert.equal(isCacheSuspect(Model), true)
    })
})
