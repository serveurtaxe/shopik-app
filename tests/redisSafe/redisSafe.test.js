import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// Read before importing: QUEUE_TIMEOUT_MS is resolved at module load.
process.env.REDIS_QUEUE_TIMEOUT_MS = '30'
const {
    isRedisReady, redisGet, redisSet, redisDel, enqueueWithFallback,
    scanDel, purgeStaleCaches, STALE_AFTER_OUTAGE
} = await import('../../server/utils/redisSafe.js')

function fakeRedis(status, commands = {}) {
    const calls = []
    const redis = { status, calls }
    for (const [name, impl] of Object.entries(commands))
        redis[name] = async (...args) => {
            calls.push([name, ...args])
            return typeof impl === 'function' ? impl(...args) : impl
        }
    return redis
}

const notReady = () => { throw new Error('Stream isn\'t writeable and enableOfflineQueue options is false') }

describe('redisGet / redisSet / redisDel', () => {
    it('reads as a miss while redis is unreachable, without sending a command', async () => {
        const redis = fakeRedis('reconnecting')

        assert.equal(await redisGet(redis, 'user_auth:1'), null)
        assert.equal(await redisSet(redis, 'user_auth:1', '{}', 'EX', 60), null)
        assert.equal(await redisDel(redis, 'user_auth:1'), 0)
        assert.deepEqual(redis.calls, [])
    })

    it('reads and writes normally when redis is ready', async () => {
        const redis = fakeRedis('ready', { get: '{"id":"1"}', set: 'OK', del: 2 })

        assert.equal(await redisGet(redis, 'user_auth:1'), '{"id":"1"}')
        assert.equal(await redisSet(redis, 'user_auth:1', '{}', 'EX', 60), 'OK')
        assert.equal(await redisDel(redis, ['a', 'b']), 2)
        assert.deepEqual(redis.calls[2], ['del', 'a', 'b'])
    })

    it('a connection that drops mid-command is a miss, not a failed request', async () => {
        const redis = fakeRedis('ready', { get: notReady, set: notReady, del: notReady })

        assert.equal(await redisGet(redis, 'k'), null)
        assert.equal(await redisSet(redis, 'k', 'v'), null)
        assert.equal(await redisDel(redis, 'k'), 0)
    })

    it('isRedisReady is only true for a client that can answer', () => {
        assert.equal(isRedisReady(undefined), false)
        assert.equal(isRedisReady({ status: 'end' }), false)
        assert.equal(isRedisReady({ status: 'reconnecting' }), false)
        assert.equal(isRedisReady({ status: 'ready' }), true)
    })
})

describe('enqueueWithFallback', () => {
    const connection = status => ({ status })
    const jobs = [{ productId: 'a' }, { productId: 'b' }]

    it('reports the batch as skipped instead of queueing into a dead redis', async () => {
        let added = 0
        const result = await enqueueWithFallback({
            connection: connection('end'),
            label: 'Test',
            jobs,
            add: () => { added++; }
        })

        assert.deepEqual(result, { enqueued: 0, skipped: 2 })
        assert.equal(added, 0)
    })

    it('queues when redis answers', async () => {
        const result = await enqueueWithFallback({
            connection: connection('ready'),
            label: 'Test',
            jobs,
            add: async () => true
        })

        assert.deepEqual(result, { enqueued: 2, skipped: 0 })
    })

    it('a rejected queue write is a skip', async () => {
        const result = await enqueueWithFallback({
            connection: connection('ready'),
            label: 'Test',
            jobs,
            add: async () => { throw new Error('max replica count reached') }
        })

        assert.deepEqual(result, { enqueued: 0, skipped: 2 })
    })

    // enableOfflineQueue: true makes a disconnected BullMQ client *wait* rather
    // than reject, so a bounded wait is the only thing keeping cron on schedule.
    it('a queue write that never resolves is a skip', async () => {
        const result = await enqueueWithFallback({
            connection: connection('ready'),
            label: 'Test',
            jobs,
            add: () => new Promise(() => { })
        })

        assert.deepEqual(result, { enqueued: 0, skipped: 2 })
    })

    it('does nothing for an empty batch', async () => {
        const result = await enqueueWithFallback({
            connection: connection('ready'),
            label: 'Test',
            jobs: [],
            add: async () => true
        })

        assert.deepEqual(result, { enqueued: 0, skipped: 0 })
    })
})

describe('scanDel / purgeStaleCaches', () => {
    function scanningRedis(pages) {
        const calls = []
        const queue = [...pages]
        return {
            status: 'ready',
            calls,
            async scan(cursor, ...args) {
                calls.push(['scan', cursor, ...args])
                const keys = queue.shift() || []
                return [queue.length ? String(calls.length) : '0', keys]
            },
            async del(...keys) {
                const flat = keys.flat() // ioredis accepts an array of keys
                calls.push(['del', ...flat])
                return flat.length
            }
        }
    }

    it('walks the whole keyspace', async () => {
        const redis = scanningRedis([['user_auth:1', 'user_auth:2'], ['user_auth:3']])

        assert.equal(await scanDel(redis, 'user_auth:*'), 3)
        assert.deepEqual(redis.calls.map(c => c[0]), ['scan', 'del', 'scan', 'del'])
    })

    it('never scans a redis that cannot answer', async () => {
        const redis = { status: 'end', scan: async () => { throw new Error('nope') } }

        assert.equal(await scanDel(redis, 'user_auth:*'), 0)
    })

    // Keys Redis could not invalidate while it was down are dropped when it
    // returns; the rate/OTP counters survive, because resetting them mid-outage
    // would loosen the SMS-flood guards.
    it('drops the caches an outage left stale and keeps the rate counters', async () => {
        const byPattern = {
            'user_auth:*': ['user_auth:1'],
            'admin_auth:*': ['admin_auth:1'],
            'user_store:*': [],
            'menu': ['menu'],
            'menu:*': ['menu:store-a'],
            'display:*': ['display:1:/products:filter']
        }
        const redis = {
            status: 'ready',
            scanned: [],
            async scan(cursor, matchOp, pattern) {
                redis.scanned.push(pattern)
                return ['0', byPattern[pattern] || []]
            },
            async del(...keys) { return keys.length }
        }

        assert.equal(await purgeStaleCaches(redis), 5)
        assert.deepEqual(redis.scanned, STALE_AFTER_OUTAGE)
        assert.ok(!redis.scanned.some(p => p.startsWith('otp_send') || p.startsWith('rl:')))
    })
})
