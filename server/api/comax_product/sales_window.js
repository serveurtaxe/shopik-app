import { resolveSalesWindow } from './salesWindow.js'

/**
 * Departments shown in the sales-window picker.
 *
 * Read from the catalog rather than the Category collection: categories only
 * contain departments that have an ACTIVE product, and a department kept out
 * by the current rules is exactly the one an admin may want to configure.
 */
export async function listDepartments(DL) {
    const rows = await DL.ComaxProduct.Model.aggregate([
        { $match: { departmentCode: { $nin: [null, ''] }, isTrailingItem: { $ne: true } } },
        { $group: { _id: { code: '$departmentCode', name: '$department' }, products: { $sum: 1 } } }
    ], { allowDiskUse: true })

    return rows
        .map(row => ({
            code: String(row._id.code),
            name: row._id.name || '',
            products: row.products
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'he') || a.code.localeCompare(b.code))
}

export default async function read(payload, { DL }) {
    const [config, departments] = await Promise.all([
        resolveSalesWindow(DL),
        listDepartments(DL)
    ])

    return {
        defaultDays: config.defaultDays,
        rules: config.rules,
        departments
    }
}

read.config = {
    permissions: ['comax_product:read']
}
