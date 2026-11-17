import log from '../utils/log.js'
import mongoose from 'mongoose'
import Redis from 'ioredis'
import handleSelect from './handleSelect.js'
import readFactory from './cache/read.js'
import { markCachesSuspect } from './cache/reseed.js'
import { purgeStaleCaches } from '#server/utils/redisSafe.js'
import { CACHE_STRATEGIES } from '#common/constants.js'
import safeJsonParse, { parseArray } from '#common/functions/safeJsonParse.js'
import { REDIS_CONNECT_TIMEOUT_MS, redisBackoffMs } from '#server/utils/redisBackoff.js'

const RECONNECT_INTERVAL_MS = (() => {
    const value = Number(process.env.REDIS_RECONNECT_INTERVAL_MS)
    return Number.isFinite(value) && value > 0 ? value : 5000
})()

const getVersionCacheKey = async (redis, Model, doc) => {
    let cacheVersion = await redis.set(`${Model.cacheName}:${doc.id}:version`, '1', 'NX', 'GET')
    if (!cacheVersion)
        cacheVersion = '1'

    return `${Model.cacheName}:${doc.id}:v${cacheVersion}`
}

const versionCache = async (redis, Model, doc) => {
    if (!doc.id) throw 'id is required for cache'
    const cacheKey = await getVersionCacheKey(redis, Model, doc)
    try {
        await redis.set(cacheKey, JSON.stringify(doc), 'EX', 24 * 60 * 60)
    } catch (e) { log.error('Cache[version] write error:', e) }
}

const hashCache = async (redis, Model, docs) => {
    if (Array.isArray(docs)) {
        if (!docs.length) return
        await redis.hset(
            Model.cacheName,
            Object.fromEntries(
                docs.map(doc => [doc.id, JSON.stringify(doc)])
            )
        )
    } else {
        await redis.hset(
            Model.cacheName,
            { [docs.id]: JSON.stringify(docs) }
        )
    }
}

async function connectRedis() {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

    const redis = new Redis(redisUrl, {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        lazyConnect: true,
        // Never give up: the tenant Redis VM can be down for minutes (it is
        // rebuilt, rebooted, or still installing) and the container lives on.
        // Returning null here is what made "redeploy" the only way back.
        retryStrategy: redisBackoffMs
    })

    // Cache writes/invalidations skipped while Redis was down: whatever the hash
    // holds when it comes back no longer matches MongoDB.
    let cacheOpsSkipped = 0
    let establishedOnce = false
    let reconnectTimer

    redis.on('error', err => log.warn('Redis notice:', err?.message || err))
    redis.on('ready', () => {
        log.success(establishedOnce ? 'Redis connection restored!' : 'Redis connection established!')
        establishedOnce = true
        if (cacheOpsSkipped) {
            const skippedCount = cacheOpsSkipped
            cacheOpsSkipped = 0
            markCachesSuspect(`${skippedCount} cache operation(s) skipped while Redis was down`)
            // Ad-hoc keys (auth/menu/page caches) are not hashsets: whatever they
            // hold now predates whatever MongoDB changed. Drop them once.
            purgeStaleCaches(redis).catch(() => { })
        }
    })
    // 'end' only happens on an explicit quit(): that is shutdown, not an outage,
    // so the reconnect watchdog below must stop.
    redis.on('end', () => clearInterval(reconnectTimer))

    // Belt and braces: ioredis owns the retry loop, but a `connect()` that
    // rejected during boot can leave it unarmed. Tick the connection ourselves
    // so a Redis that returns later is picked up without a redeploy.
    reconnectTimer = setInterval(() => {
        if (redis.status === 'ready' || redis.status === 'connecting' || redis.status === 'reconnecting')
            return
        redis.connect().catch(() => { })
    }, RECONNECT_INTERVAL_MS)
    reconnectTimer.unref()

    const connecting = redis.connect()
    // The losing side of the race below must not surface as an unhandled rejection.
    connecting.catch(() => { })

    try {
        await Promise.race([
            connecting,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Redis connect timeout (${REDIS_CONNECT_TIMEOUT_MS}ms)`)), REDIS_CONNECT_TIMEOUT_MS))
        ])
    } catch (e) {
        log.warn('Redis connection deferred, proceeding with direct database access:', e?.message || e)
    }

    redis.init = Model => {
        const ready = () => redis.status === 'ready'
        const skipped = () => {
            cacheOpsSkipped++
            return null
        }

        const get = async (ids, select) => {
            if (!ready()) return skipped()

            let results
            try {
                if (Model.cacheStrategy === CACHE_STRATEGIES.VERSION) {
                    if (typeof ids === 'string') {
                        const cacheKey = await getVersionCacheKey(redis, Model, { id: ids })
                        const cacheValue = await redis.get(cacheKey)
                        if (!cacheValue) return null
                        results = safeJsonParse(cacheValue)
                    } else if (Array.isArray(ids)) {
                        const cacheKeys = await Promise.all(
                            ids.map(id => getVersionCacheKey(redis, Model, { id }))
                        )
                        const cacheValues = await redis.mget(cacheKeys)
                        results = parseArray(cacheValues)
                    }
                }
                if (Model.cacheStrategy === CACHE_STRATEGIES.HASHSET) {
                    if (Array.isArray(ids))
                        ids = [...new Set(ids)]
                    const values = await redis.hmget(Model.cacheName, ids)
                    if (Array.isArray(ids))
                        results = parseArray(values)
                    else {
                        const [cacheValue] = values
                        if (!cacheValue) return null

                        results = safeJsonParse(cacheValue)
                    }
                }
            } catch (e) {
                // A cache read that cannot be answered is a miss, not an error:
                // the caller has a MongoDB to fall back to.
                log.warn(`Cache[${Model.modelName}] get skipped:`, e?.message || e)
                return skipped()
            }
            return handleSelect(results, select)
        }

        const add = async (docs) => {
            if (!ready()) return skipped()

            try {
                if (Model.cacheStrategy === CACHE_STRATEGIES.VERSION) {
                    if (Array.isArray(docs)) {
                        if (!docs?.length) return
                        await Promise.all(docs.map(doc => versionCache(redis, Model, doc)))
                    } else {
                        await versionCache(redis, Model, docs)
                    }
                    return
                }
                if (Model.cacheStrategy === CACHE_STRATEGIES.HASHSET) {
                    await hashCache(redis, Model, docs)
                    return
                }
            } catch (e) {
                log.warn(`Cache[${Model.modelName}] add skipped:`, e?.message || e)
                return skipped()
            }
        }

        const del = async (ids) => {
            if (!ids?.length) return
            if (!ready()) return skipped()

            try {
                if (Model.cacheStrategy === CACHE_STRATEGIES.HASHSET) {
                    await redis.hdel(Model.cacheName, ids)
                    return
                }
                if (Model.cacheStrategy === CACHE_STRATEGIES.VERSION) {
                    const prefix = Model.cacheName
                    if (typeof ids === 'string') {
                        await redis.incr(`${prefix}:${ids}:version`)
                    }
                    if (Array.isArray(ids)) {
                        const pipeline = redis.multi()
                        for (const id of ids) {
                            pipeline.incr(`${prefix}:${id}:version`)
                        }
                        await pipeline.exec()
                    }
                    return
                }
            } catch (e) {
                log.warn(`Cache[${Model.modelName}] del skipped:`, e?.message || e)
                return skipped()
            }
        }

        // Used by the reseed path: it has no client of its own, only the model.
        const clear = async () => {
            if (!ready()) return skipped()
            try {
                return await redis.del(Model.cacheName)
            } catch (e) {
                log.warn(`Cache[${Model.modelName}] clear skipped:`, e?.message || e)
                return skipped()
            }
        }

        const read = readFactory(redis, Model)

        return {
            ready,
            read,
            get,
            add,
            del,
            clear
        }
    }

    return redis
}

const getDisconnect = redis => async function disconnect() {
    try {
        await mongoose.disconnect()
        if (redis) await redis.quit()
        log.log('Server shut down gracefully')
    } catch (e) {
        log.error('Shutdown error:', e)
    }
}

const getHealth = redis => async function health() {
    const mongoOk = mongoose.connection.readyState === 1
    const redisOk = redis?.status === 'ready' ? await redis.ping().catch(() => null) : false
    return { mongo: mongoOk, redis: redisOk === 'PONG' }
}

export default async function connect() {
    log.warn('MongoDB connecting...')

    try {
        const mongoUri = process.env.DB_URI || process.env.DB
        if (!mongoUri) {
            throw new Error('No MongoDB connection string provided in DB_URI or DB environment variable')
        }
        await mongoose.connect(mongoUri)
        log.success('MongoDB connection established!')
    } catch (error) {
        log.error('MongoDB connection failed!')
        throw error
    }

    log.warn('Redis connecting...')

    let redis = null

    try {
        redis = await connectRedis()
    } catch (error) {
        log.warn('Redis connection skipped:', error?.message || error)
    }

    return {
        redis,
        disconnect: getDisconnect(redis),
        health: getHealth(redis)
    }
}
