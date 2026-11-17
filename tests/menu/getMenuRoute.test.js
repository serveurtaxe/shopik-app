import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import menuGet from '../../server/api/menu/get.js'
import getUserStore from '../../server/utils/data/getUserStore.js'
import { GUEST_CART_TOKEN_COOKIE, MENU_CACHE_KEY } from '../../common/constants.js'

// The menu is the one part of the storefront that a client-side store change
// cannot carry over: it is cached per store and only reaches the browser through
// the SSR payload. These fakes stand in for Redis, the product index and the
// category tree so the route contract can be checked without a database.
// `status: 'ready'` matters: a cache is only used while its client can answer.
const CATEGORIES = [
    { id: 'nc:7', name: 'ירקות', parentId: null, slug: 'ירקות', path: 'ירקות', sortOrder: 1 },
    { id: 'nc:7:41', name: 'עגבניות', parentId: 'nc:7', slug: 'עגבניות', path: 'ירקות/עגבניות', sortOrder: 1 },
    { id: 'nc:9', name: 'יין', parentId: null, slug: 'יין', path: 'יין', sortOrder: 2 }
]

const fakeRedis = () => {
    const entries = {}
    return {
        entries,
        status: 'ready',
        get: async key => entries[key] ?? null,
        set: async (key, value) => { entries[key] = value; return 1 }
    }
}

const fakeBoot = ({ storeId = null, categoryIds = CATEGORIES.map(c => c.id) } = {}) => {
    const reads = []
    const DL = {
        redis: fakeRedis(),
        Product: {
            constants: { STATUS: { ACTIVE: 'active' } },
            Model: {
                distinct: async (field, filter) => {
                    reads.push({ distinct: { field, filter } })
                    return categoryIds
                }
            }
        },
        Category: {
            read: async filter => {
                reads.push({ categoryRead: filter })
                return CATEGORIES
            }
        },
        Order: { readOne: async () => storeId ? { storeId } : null },
        GuestCart: { readOne: async () => null }
    }
    return {
        DL,
        reads,
        utils: {
            data: { getUserStore },
            auth: { getUser: async () => { throw new Error('no session') } }
        }
    }
}

describe('menu/get', () => {
    it('is a lax storefront route with no payload requirements', () => {
        assert.equal(menuGet.config.auth, 'lax')
        assert.equal(menuGet.config.permissions, undefined)
        assert.equal(menuGet.config.required, undefined)
    })

    it('returns the menu of the store resolved from the cart order', async () => {
        const boot = fakeBoot({ storeId: 'store-b' })
        const res = await menuGet({}, { ...boot, req: {}, _user: { id: 'u1' } })

        assert.deepEqual(boot.reads[0], {
            distinct: { field: 'category.pathIds', filter: { status: 'active', storeIds: 'store-b' } }
        })

        const [products, sales] = res.menu
        assert.equal(products.path, '/products')
        assert.deepEqual(products.children.map(c => c.name), ['ירקות', 'יין'])
        assert.equal(products.children[0].children[0].path, '/products/ירקות/עגבניות')
        assert.deepEqual(sales, { name: 'Sales', path: '/sales', icon: 'salePercent' })

        assert.ok(boot.DL.redis.entries[`${MENU_CACHE_KEY}:store-b`])
    })

    it('leaves guests on the store-less menu, and their guest cart on its store', async () => {
        const cookieless = fakeBoot()
        await menuGet({}, { ...cookieless, req: {} })
        assert.equal(cookieless.reads[0].distinct.filter.storeIds, undefined)
        assert.ok(cookieless.DL.redis.entries[`${MENU_CACHE_KEY}:any`])

        const withCart = fakeBoot()
        withCart.DL.GuestCart.readOne = async () => ({ storeId: 'store-guest' })
        await menuGet({}, {
            ...withCart,
            req: { cookies: { [GUEST_CART_TOKEN_COOKIE]: 'guest-token' } }
        })
        assert.equal(withCart.reads[0].distinct.filter.storeIds, 'store-guest')
        assert.ok(withCart.DL.redis.entries[`${MENU_CACHE_KEY}:store-guest`])
    })

    it('serves a warm store from the cache instead of the product index', async () => {
        const boot = fakeBoot({ storeId: 'store-b' })
        const context = { ...boot, req: {}, _user: { id: 'u1' } }

        const first = await menuGet({}, context)
        const readCount = boot.reads.length
        const again = await menuGet({}, context)

        assert.equal(boot.reads.length, readCount)
        assert.deepEqual(again.menu, first.menu)
    })

    it('keeps a store without active products empty', async () => {
        const boot = fakeBoot({ storeId: 'store-empty', categoryIds: [] })
        const res = await menuGet({}, { ...boot, req: {}, _user: { id: 'u1' } })

        // The category read must not run: an empty $in would mean every category.
        assert.deepEqual(boot.reads.map(Object.keys), [['distinct']])
        assert.deepEqual(res.menu[0].children, [])
    })
})
