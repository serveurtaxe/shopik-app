// Comax codes are only unique within a level: e.g. 9 is both the
// super-department "שתיה" and a department under "פירות וירקות", and 13 is both
// "נון פוד" and "פירות וירקות טריים". Category ids must therefore be qualified
// by level, otherwise the two nodes share an id and the tree merges their
// children.
export const superDepartmentId = code => `sd:${code}`
export const departmentId = code => `d:${code}`
export const groupId = code => `g:${code}`
export const subGroupId = code => `sg:${code}`

// Positional on purpose: Product.category.pathIds index 0..3 maps to these
// levels, and product filters match any ancestor id.
export function buildCategoryPathIds(comax) {
    return [
        comax.superDepartmentCode ? superDepartmentId(comax.superDepartmentCode) : null,
        comax.departmentCode ? departmentId(comax.departmentCode) : null,
        comax.groupCode ? groupId(comax.groupCode) : null,
        comax.subGroupCode ? subGroupId(comax.subGroupCode) : null
    ].filter(Boolean)
}
