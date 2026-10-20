import toSlug from '#common/functions/toSlug.js'
import { invalidateMenu } from '#server/utils/data/getMenu.js'
import { superDepartmentId, departmentId, groupId, subGroupId } from './categoryIds.js'

export default async function buildCategories(payload, { DL }) {
    // Distinct category tuples for ACTIVE products only. Start from Product so
    // hidden/archived docs never create categories, then join ComaxProduct for
    // the full name hierarchy. Aggregation keeps the 10-50k catalog in the DB
    // (a full read here OOMed 256MB containers — see comax_product/sync).
    const tuples = await DL.Product.Model.aggregate([
        {
            $match: {
                status: DL.Product.constants.STATUS.ACTIVE
            }
        },
        {
            $lookup: {
                from: DL.ComaxProduct.Model.collection.name,
                localField: 'barcode',
                foreignField: 'barcode',
                pipeline: [
                    {
                        $project: {
                            _id: 0,
                            superDepartmentCode: 1,
                            superDepartment: 1,
                            departmentCode: 1,
                            department: 1,
                            groupCode: 1,
                            group: 1,
                            subGroupCode: 1,
                            subGroup: 1
                        }
                    },
                    { $limit: 1 }
                ],
                as: 'comax'
            }
        },
        { $unwind: '$comax' },
        {
            $match: {
                'comax.superDepartmentCode': { $exists: true, $nin: ['12', null] },
                'comax.departmentCode': { $exists: true },
                'comax.groupCode': { $exists: true }
            }
        },
        {
            $group: {
                _id: {
                    superDepartmentCode: '$comax.superDepartmentCode',
                    superDepartment: '$comax.superDepartment',
                    departmentCode: '$comax.departmentCode',
                    department: '$comax.department',
                    groupCode: '$comax.groupCode',
                    group: '$comax.group',
                    subGroupCode: '$comax.subGroupCode',
                    subGroup: '$comax.subGroup'
                }
            }
        },
        {
            $project: {
                _id: 0,
                superDepartmentCode: '$_id.superDepartmentCode',
                superDepartment: '$_id.superDepartment',
                departmentCode: '$_id.departmentCode',
                department: '$_id.department',
                groupCode: '$_id.groupCode',
                group: '$_id.group',
                subGroupCode: '$_id.subGroupCode',
                subGroup: '$_id.subGroup'
            }
        }
    ])

    const superDepartmentMap = new Map()
    const departmentMap = new Map()
    const groupMap = new Map()
    const subGroupMap = new Map()

    for (const p of tuples) {
        const allCodes = [p.superDepartmentCode, p.departmentCode, p.groupCode, p.subGroupCode]
        const allNames = [p.superDepartment, p.department, p.group, p.subGroup]
        const hasAllCodes = allCodes.every(code => code)
        const hasAllNames = allNames.every(name => name)

        if (!hasAllCodes || !hasAllNames) {
            continue
        }

        const superDepartmentSlug = toSlug(p.superDepartment)
        const departmentSlug = toSlug(p.department)
        const groupSlug = toSlug(p.group)
        const subGroupSlug = toSlug(p.subGroup)

        const superDepartmentKey = superDepartmentId(p.superDepartmentCode)
        const departmentKey = departmentId(p.departmentCode)
        const groupKey = groupId(p.groupCode)

        superDepartmentMap.set(superDepartmentKey, {
            name: p.superDepartment,
            slug: superDepartmentSlug,
            path: superDepartmentSlug,
            parentId: null,
            parentIds: []
        })

        departmentMap.set(departmentKey, {
            name: p.department,
            slug: departmentSlug,
            path: `${superDepartmentSlug}/${departmentSlug}`,
            parentId: superDepartmentKey,
            parentIds: [superDepartmentKey]
        })

        groupMap.set(groupKey, {
            name: p.group,
            slug: groupSlug,
            path: `${superDepartmentSlug}/${departmentSlug}/${groupSlug}`,
            parentId: departmentKey,
            parentIds: [superDepartmentKey, departmentKey]
        })

        subGroupMap.set(subGroupId(p.subGroupCode), {
            name: p.subGroup,
            slug: subGroupSlug,
            path: `${superDepartmentSlug}/${departmentSlug}/${groupSlug}/${subGroupSlug}`,
            parentId: groupKey,
            parentIds: [superDepartmentKey, departmentKey, groupKey]
        })
    }

    const categories = []

    for (const [code, superDept] of superDepartmentMap) {
        categories.push({
            id: code,
            name: superDept.name,
            slug: superDept.slug,
            path: superDept.path,
            parentId: null,
            parentIds: []
        })
    }

    for (const [code, dept] of departmentMap) {
        categories.push({
            id: code,
            name: dept.name,
            slug: dept.slug,
            path: dept.path,
            parentId: dept.parentId,
            parentIds: dept.parentIds
        })
    }

    for (const [code, group] of groupMap) {
        categories.push({
            id: code,
            name: group.name,
            slug: group.slug,
            path: group.path,
            parentId: group.parentId,
            parentIds: group.parentIds
        })
    }

    for (const [code, subGroup] of subGroupMap) {
        categories.push({
            id: code,
            name: subGroup.name,
            slug: subGroup.slug,
            path: subGroup.path,
            parentId: subGroup.parentId,
            parentIds: subGroup.parentIds
        })
    }

    const categoryIds = categories.map(c => c.id)

    if (categories.length > 0)
        await DL.Category.bulkWrite({ docs: categories })

    // Categories are fully derived from active products, so anything left over
    // is stale. Delete the docs and their HASHSET cache entries.
    const staleIds = await DL.Category.Model.distinct('id', { id: { $nin: categoryIds } })
    if (staleIds.length > 0) {
        await DL.Category.Model.deleteMany({ id: { $in: staleIds } })
        await DL.Category.cache?.del(staleIds)
    }

    if (categories.length > 0 || staleIds.length > 0) {
        // Category docs feed the storefront menu (60min Redis cache) — the
        // bulkWrite $set only touches synced fields so manual `icon` values
        // survive, but the cached menu must be rebuilt on next request.
        await invalidateMenu({ DL })
    }

    console.log(`[Comax Categories] Built ${categories.length} categories from active comax products, removed ${staleIds.length} stale`)

    return {
        message: 'Categories built successfully',
        count: categories.length,
        removed: staleIds.length
    }
}

buildCategories.config = {
    required: [],
    permissions: ['product:update'],
    auth: 'required'
}
