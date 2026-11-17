import { ADMIN_TOKEN_COOKIE } from '#common/constants.js'
import getPlatform from '#server/utils/getPlatform.js'
import safeJsonParse from '#common/functions/safeJsonParse.js'
import { redisGet, redisSet } from '#server/utils/redisSafe.js'

export default async function getAdmin(req, { DL, utils }) {
    const { cookies } = req
    const platform = getPlatform(req)
    const token = cookies[ADMIN_TOKEN_COOKIE]
    const { id } = utils.auth.verifyToken(token)
    const cacheId = `admin_auth:${id}`
    let admin
    const cached = await redisGet(DL.redis, cacheId)
    if (cached)
        admin = safeJsonParse(cached)
    else {
        admin = await DL.Admin.Model.findOne({ id }, { _id: 0, id: 1, roleId: 1, tokens: 1, name: 1, storeIds: 1, currentStoreId: 1 }).lean()
        await redisSet(DL.redis, `admin_auth:${id}`, JSON.stringify(admin), 'EX', 60 * 60 * 24)
    }
    if (!admin)
        throw { status: 401, message: 'Unauthorized' }

    if (admin.tokens?.[platform] !== token)
        throw { status: 401, message: 'Unauthorized' }

    delete admin.tokens

    const role = await DL.Role.readById(admin.roleId)

    admin.role = role
    admin.isSuperAdmin = role.permissions.includes('admin:super')
    admin.hasPermission = permission =>
        admin.isSuperAdmin ||
        admin.role.permissions.includes(permission)

    return admin
}