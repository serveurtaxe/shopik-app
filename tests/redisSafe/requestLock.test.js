import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { acquireRequestLock, REQUEST_LOCK_TTL_SEC } from '../../server/utils/requestLock.js'

const redisLocks = new Map()

function fakeRedis(status = 'ready') {
    const calls = []
    return {
        status,
        calls,
        async set(key, token, ...args) {
            calls.push(['set', key, token, ...args])
            if (redisLocks.has(key)) return null
            redisLocks.set(key, token)
            return 'OK'
        },
        async del(key) {
            calls.push(['del', key])
            const had = redisLocks.delete(key)
            return had ? 1 : 0
        }
    }
}

const acquire = (redis, key, token) =>
    acquireRequestLock({ redis, key, token })

describe('request lock (preventMultiple)', () => {
    it('uses redis when it can and releases there', async () => {
        redisLocks.clear()
        const redis = fakeRedis()

        const release = await acquire(redis, 'lock:order/create', 'r1')
        const blocked = await acquire(redis, 'lock:order/create', 'r2')

        assert.equal(typeof release, 'function')
        assert.equal(blocked, null)

        await release()
        assert.notEqual(await acquire(redis, 'lock:order/create', 'r3'), null)
        assert.deepEqual(redis.calls[0], ['set', 'lock:order/create', 'r1', 'NX', 'EX', REQUEST_LOCK_TTL_SEC])
    })

    it('falls back to this process when redis is unreachable', async () => {
        const redis = fakeRedis('reconnecting')

        const release = await acquire(redis, 'lock:cart/add', 'r1')
        const blocked = await acquire(redis, 'lock:cart/add', 'r2')

        assert.equal(typeof release, 'function')
        assert.equal(blocked, null)
        // Nothing was sent to a redis that cannot answer.
        assert.deepEqual(redis.calls, [])

        await release()
        assert.notEqual(await acquire(redis, 'lock:cart/add', 'r3'), null)
    })

    it('falls back when redis rejects mid-request', async () => {
        const redis = fakeRedis('ready')
        redis.set = async () => { throw new Error('Stream isn\'t writeable') }

        const release = await acquire(redis, 'lock:order/submit', 'r1')
        assert.equal(typeof release, 'function')
        assert.equal(await acquire(redis, 'lock:order/submit', 'r2'), null)
    })

    it('an expired lock stops blocking', async () => {
        const release = await acquireRequestLock({
            redis: null,
            key: 'lock:short',
            token: 'r1',
            ttlSec: 0
        })

        assert.notEqual(release, null)
        assert.notEqual(await acquireRequestLock({ redis: null, key: 'lock:short', token: 'r2', ttlSec: 0 }), null)
    })

    it('a release never hands over another holder\'s lock', async () => {
        const first = await acquireRequestLock({ redis: null, key: 'lock:mine', token: 'r1' })
        await first()
        const second = await acquireRequestLock({ redis: null, key: 'lock:mine', token: 'r2' })
        await first()
        const third = await acquireRequestLock({ redis: null, key: 'lock:mine', token: 'r3' })

        assert.notEqual(second, null)
        // `first` releasing again must not free the lock `second` is holding.
        assert.equal(third, null)
        await second()
    })
})
