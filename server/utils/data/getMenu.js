import { MENU_CACHE_KEY } from '#common/constants.js'
import getUserStore from './getUserStore.js'
import { scanDel } from './displayBlocks.js'
import { redisDel, redisGet, redisSet } from '#server/utils/redisSafe.js'

const CACHE_TTL_SEC = 60 * 60

const baseMenu = [
    {
        name: 'Sales',
        path: '/sales',
        icon: 'salePercent'
    }
]

function buildMenu(categories) {
    const byParent = new Map()
    for (const category of categories) {
        const key = category.parentId || null
        if (!byParent.has(key)) byParent.set(key, [])
        byParent.get(key).push(category)
    }

    function build(parentId) {
        return (byParent.get(parentId) || []).map(category => {
            const node = { name: category.name }
            if (category.path) node.path = `/products/${category.path}`
            if (category.icon) node.icon = category.icon
            const children = build(category.id)
            if (children.length) node.children = children
            return node
        })
    }

    return build(null)
}

export default async function getMenu({ DL, req, utils, _user }) {
    // Menu is store-scoped: only categories with an active product in the
    // resolved store. Guests / users without a store see the union of stores.
    const storeId = await getUserStore(req, { DL, utils, _user }).catch(() => null)
    const cacheKey = `${MENU_CACHE_KEY}:${storeId || 'any'}`

    const cached = await redisGet(DL.redis, cacheKey).catch(() => null)
    if (cached) return JSON.parse(cached)

    const productFilter = { status: DL.Product.constants.STATUS.ACTIVE }
    if (storeId) productFilter.storeIds = storeId

    const categoryIds = await DL.Product.Model.distinct('category.pathIds', productFilter)
    // An empty $in is stripped by the DL filter sanitizer, which would turn this
    // into "all active categories" — skip the read so an empty store stays empty.
    const categories = categoryIds.length
        ? await DL.Category.read(
            { id: { $in: categoryIds }, active: true },
            {
                _id: 0,
                name: 1,
                slug: 1,
                parentId: 1,
                id: 1,
                icon: 1,
                path: 1,
                sortOrder: 1
            },
            { limit: 0, sort: { sortOrder: 1, name: 1 } }
        )
        : []

    const menu = [
        {
            name: 'all_departments',
            path: '/products',
            icon: 'grid',
            children: buildMenu(categories || [])
        },
        ...baseMenu
    ]

    await redisSet(DL.redis, cacheKey, JSON.stringify(menu), 'EX', CACHE_TTL_SEC).catch(() => null)
    return menu
}

// Menu is cached per store (menu:<storeId|any>), so a plain DEL is not enough.
export async function invalidateMenu({ DL }) {
    if (!DL?.redis) return
    await scanDel(DL.redis, `${MENU_CACHE_KEY}:*`)
    await redisDel(DL.redis, MENU_CACHE_KEY)
}
