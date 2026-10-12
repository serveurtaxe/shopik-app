import toSlug from '#common/functions/toSlug.js'
import { MENU_CACHE_KEY } from '#common/constants.js'

const baseMenu = [
    {
        name: 'Sales',
        path: '/sales',
        icon: 'salePercent'
    }
]

export default async function getMenu({ DL }) {
    // TODO: add storeId
    const cached = await DL.redis?.get('menu')
    if (cached) {
        return JSON.parse(cached)
    }
    const categoriesIds = await DL.Product.Model.distinct('category.pathIds', {
        status: DL.Product.constants.STATUS.ACTIVE
    })
    const categories = await DL.Category.read(
        { id: { $in: categoriesIds }, active: true },
        { _id: 0, name: 1, slug: 1, parentId: 1, id: 1, icon: 1 },
        { sort: { name: 1 }, limit: 0 }
    )
    const categoriesByParent = categories.reduce((acc, category) => {
        const parentId = category.parentId || null
        if (!acc[parentId]) acc[parentId] = []
        acc[parentId].push(category)
        return acc
    }, {})

    // Merge siblings by slug so two categories with the same name (different
    // ids/codes) produce a single menu entry. Children of merged duplicates
    // are collected from ALL duplicate ids and merged recursively.
    function buildBranch(parentIds, prefix = '/products') {
        const direct = parentIds.flatMap(parentId => categoriesByParent[parentId] || [])
        const bySlug = new Map()
        for (const child of direct) {
            const slug = child.slug || toSlug(child.name)
            if (!slug) continue
            let entry = bySlug.get(slug)
            if (!entry) {
                entry = { name: child.name, icon: child.icon, ids: [] }
                bySlug.set(slug, entry)
            }
            // Merged duplicates: first non-empty icon wins
            if (!entry.icon && child.icon) entry.icon = child.icon
            entry.ids.push(child.id)
        }
        return [...bySlug.entries()].map(([slug, { name, icon, ids }]) => {
            const nodePath = `${prefix}/${slug}`
            const node = { name, ...(icon ? { icon } : {}) }
            const children = buildBranch(ids, nodePath)
            if (children.length > 0) node.children = children
            return node
        })
    }

    const tree = buildBranch([null])
    const menu = [
        {
            name: 'Products',
            path: '/products',
            icon: 'grid',
            children: tree
        },
        ...baseMenu,
    ]
    await DL.redis?.set('menu', JSON.stringify(menu), 'EX', 60 * 60)
    return menu
}

export async function invalidateMenu({ DL }) {
    await DL.redis?.del(MENU_CACHE_KEY)
}
