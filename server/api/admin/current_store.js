import { redisDel } from '#server/utils/redisSafe.js'
import storeScope, { assertStoreVisible } from '#server/utils/data/storeScope.js'

export default async function current_store({ storeId }, { DL, _admin }) {
    if (!storeId) throw { status: 400, message: 'storeId required' }

    // Resolve through the canonical rule — storeIds rides the cached auth payload
    // (getAdmin), invalidated on every switch. An unrestricted admin (super, or
    // store:all with no explicit stores) may pick any store.
    const scope = storeScope({ _admin })
    assertStoreVisible(storeId, scope)

    // Authorisation first, then existence, so a 403 never reveals whether an id exists.
    // Only checked for unrestricted admins: a scoped admin's id is already vetted by
    // membership, and this keeps the common path to one cached read.
    if (scope === null && !await DL.Store.readById(storeId))
        throw { status: 400, message: 'store not found' }

    await DL.Admin.updateOne({ id: _admin.id }, { currentStoreId: storeId })
    // A skipped invalidation is harmless while Redis is down: getAdmin answers
    // from MongoDB whenever Redis cannot answer.
    await redisDel(DL.redis, `admin_auth:${_admin.id}`)
    return { currentStoreId: storeId }
}

current_store.config = {
    permissions: ['order:pick', 'order:ship', 'order:read', 'order:pick:manage', 'order:ship:manage']
}
