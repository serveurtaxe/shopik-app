import { COMAX_META_FIELDS, metaFromComax } from '#server/services/categoryMap/index.js'

const CATEGORY_SELECT = {
    _id: 0,
    id: 1,
    code: 1,
    name: 1,
    slug: 1,
    path: 1,
    parentId: 1,
    parentIds: 1,
    icon: 1,
    level: 1,
    sortOrder: 1,
    active: 1
}

const MAP_SELECT = {
    _id: 0,
    subGroupCode: 1,
    categoryId: 1,
    superDepartmentCode: 1,
    superDepartment: 1,
    departmentCode: 1,
    department: 1,
    groupCode: 1,
    group: 1,
    subGroup: 1,
    showOnSite: 1,
    requireKashrut: 1,
    categoryActive: 1
}

function withMeta(mapDoc) {
    return {
        code: mapDoc.subGroupCode,
        categoryId: mapDoc.categoryId || null,
        productCount: 0,
        // Missing flags mean the default: shown, no kashrut requirement, active.
        showOnSite: mapDoc.showOnSite !== false,
        requireKashrut: mapDoc.requireKashrut === true,
        categoryActive: mapDoc.categoryActive !== false,
        oldPath: [mapDoc.superDepartment, mapDoc.department, mapDoc.group, mapDoc.subGroup]
            .filter(Boolean)
            .join(' / '),
        superDepartmentCode: mapDoc.superDepartmentCode || null,
        superDepartment: mapDoc.superDepartment || null,
        departmentCode: mapDoc.departmentCode || null,
        department: mapDoc.department || null,
        groupCode: mapDoc.groupCode || null,
        group: mapDoc.group || null,
        subGroup: mapDoc.subGroup || null
    }
}

export default async function tree(payload, { DL }) {
    const activeFilter = { status: DL.Product.constants.STATUS.ACTIVE }
    const [categories, mapDocs, counts, activeProducts] = await Promise.all([
        DL.Category.read({}, CATEGORY_SELECT, { limit: 0, sort: { level: 1, sortOrder: 1, name: 1 } }),
        DL.CategoryMap.read({}, MAP_SELECT, { limit: 0 }),
        DL.Product.Model.aggregate([
            { $match: activeFilter },
            { $group: { _id: '$comaxSubGroupCode', count: { $sum: 1 } } }
        ], { allowDiskUse: true }),
        DL.Product.Model.countDocuments(activeFilter)
    ])

    const countByCode = new Map()
    for (const row of counts || []) {
        if (row?._id == null) continue
        countByCode.set(String(row._id), row.count || 0)
    }

    const categoryIds = new Set((categories || []).map(category => category.id))
    const mapByCode = new Map()
    for (const row of mapDocs || [])
        mapByCode.set(String(row.subGroupCode), row)

    // A map row pointing at a category that no longer exists is treated as
    // unassigned so it stays visible and fixable in the admin.
    const isMapped = code => {
        const categoryId = mapByCode.get(code)?.categoryId
        return Boolean(categoryId && categoryIds.has(categoryId))
    }

    const missingCodes = [...countByCode.keys()].filter(code => !isMapped(code))

    const missingMeta = new Map()
    if (missingCodes.length) {
        const docs = await DL.ComaxProduct.Model.find(
            { subGroupCode: { $in: missingCodes } },
            { _id: 0, subGroupCode: 1, ...COMAX_META_FIELDS }
        ).lean()
        for (const doc of docs) {
            const code = String(doc.subGroupCode)
            if (!missingMeta.has(code)) missingMeta.set(code, metaFromComax(doc))
        }
    }

    const assigned = []
    for (const row of mapDocs || []) {
        if (!row.categoryId || !categoryIds.has(row.categoryId)) continue
        const entry = withMeta(row)
        entry.productCount = countByCode.get(String(row.subGroupCode)) || 0
        assigned.push(entry)
    }

    const unassigned = []
    for (const [code, productCount] of countByCode) {
        if (isMapped(code)) continue
        const mapDoc = mapByCode.get(code)
        const entry = withMeta(mapDoc || {
            subGroupCode: code,
            categoryId: null,
            ...(missingMeta.get(code) || {})
        })
        entry.productCount = productCount
        unassigned.push(entry)
    }

    assigned.sort((a, b) => b.productCount - a.productCount || a.code.localeCompare(b.code))
    unassigned.sort((a, b) => b.productCount - a.productCount || a.code.localeCompare(b.code))

    const activeSubGroups = countByCode.size
    const mappedSubGroups = [...countByCode.keys()].filter(isMapped).length

    return {
        categories: categories || [],
        assigned,
        unassigned,
        coverage: {
            activeProducts,
            // Active products whose Comax row has no sub-group code: they can
            // never be covered by the map, so surface the count separately.
            noCodeProducts: activeProducts - [...countByCode.values()].reduce((sum, count) => sum + count, 0),
            activeSubGroups,
            mappedSubGroups,
            unassignedSubGroups: activeSubGroups - mappedSubGroups,
            unassignedProducts: unassigned.reduce((sum, entry) => sum + entry.productCount, 0)
        }
    }
}

tree.config = {
    permissions: ['category:read']
}
