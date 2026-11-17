import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

// A wrong import path in a file no test loads (connect.js, the queues, the cron
// jobs) only shows up when a container boots. Importing them here is cheap:
// none of these modules connect, schedule, or write anything on import.
const MODULES = [
    'dl/connect.js',
    'dl/index.js',
    'dl/cache/read.js',
    'dl/cache/seed.js',
    'dl/cache/reseed.js',
    'dl/models/cronLock.js',
    'dl/defaults/update.js',
    'utils/redisBackoff.js',
    'utils/redisSafe.js',
    'utils/requestLock.js',
    'utils/cronLock.js',
    'utils/data/getMenu.js',
    'utils/data/getUserStore.js',
    'utils/data/displayBlocks.js',
    'queues/imageQueue.js',
    'queues/gs1Queues.js',
    'workers/imageWorker.js',
    'workers/gs1FetchWorker.js',
    'workers/gs1ProcessWorker.js',
    'services/image/enqueue.js',
    'services/gs1/sync.js',
    'cron/nightlySync.js',
    'cron/gs1Sync.js',
    'cron/salesSync.js',
    'cron/refundRetry.js',
    'cron/invoiceRetry.js',
    'cron/holidaySeed.js',
    'cron/windowSync.js',
    'cron/deliveryDocsSync.js',
    'router.js',
    // Every call site the redisGet/redisSet/redisDel sweep rewrote: each one is
    // imported at boot, so a bad import line here is a boot failure, not a test.
    'api/admin/login.js',
    'api/admin/logout.js',
    'api/admin/update.js',
    'api/admin/current_store.js',
    'api/bot/otp_verify.js',
    'api/display_block/get.js',
    'api/user/delivery_method.js',
    'api/user/edit.js',
    'api/user/login.js',
    'api/user/logout.js',
    'api/user/update.js',
    'api/user/verify_phone.js',
    'api/user/address/active.js',
    'api/user/address/add.js',
    'api/user/address/edit.js',
    'api/user/address/remove.js',
    'api/user/address/admin_active.js',
    'api/user/address/admin_add.js',
    'api/user/address/admin_edit.js',
    'api/user/address/admin_remove.js',
    'utils/auth/getAdmin.js',
    'utils/auth/getUser.js'
]

describe('redis-resilience modules load', () => {
    for (const file of MODULES) {
        it(`server/${file}`, async () => {
            const module = await import(`../../server/${file}`)
            assert.ok(Object.keys(module).length, `${file} exports nothing`)
        })
    }

    it('the entry points are the ones the app calls', async () => {
        const connect = (await import('../../server/dl/connect.js')).default
        const { acquireLock } = await import('../../server/utils/cronLock.js')
        const { redisGet, redisSet, redisDel, enqueueWithFallback } =
            await import('../../server/utils/redisSafe.js')

        assert.equal(typeof connect, 'function')
        assert.equal(typeof acquireLock, 'function')
        assert.deepEqual([redisGet, redisSet, redisDel, enqueueWithFallback].map(f => typeof f),
            ['function', 'function', 'function', 'function'])
    })
})
