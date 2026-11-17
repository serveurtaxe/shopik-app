import diff from '#common/functions/diff.js'
import { redisDel } from '#server/utils/redisSafe.js'

export default async function update(payload, { DL, validators, utils }) {

    const { id } = payload
    const admin = await DL.Admin.readById(id)
    if (!admin)
        throw { status: 400, message: 'admin does not exist' }

    await validators.roleId(admin.roleId, arguments[1], true)

    const name = utils.extractFields.getName(payload)
    if (name) payload.name = name

    await validators.storeIds(payload, arguments[1], admin)

    const update = diff(admin, payload)

    const nothingToUpdate = Object.keys(update).length === 0
    if (nothingToUpdate)
        return admin

    if (update.roleId) {
        await validators.roleId(update.roleId, arguments[1], true)
    }

    // storeIds/currentStoreId live in the cached auth payload (getAdmin) — drop it
    if (update.roleId || update.storeIds || 'currentStoreId' in update) {
        await redisDel(DL.redis, `admin_auth:${id}`)
    }

    if (update.idNum) {
        await validators.idNum(update.idNum, arguments[1])
    }

    const updated = await DL.Admin.updateOne({ id }, update)
    return updated
}

update.config = {
    required: ['id'],
    permissions: 'admin:update'
}
