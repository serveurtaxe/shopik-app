import { ADMIN_TOKEN_COOKIE } from '#common/constants.js'
import { redisDel } from '#server/utils/redisSafe.js'

export default async function logout(payload, { DL, _admin, platform, clearCookie }) {
    await DL.Admin.updateOne({ id: _admin.id }, {
        $set: { lastLogout: new Date() },
        $unset: { [`tokens.${platform}`]: '' }
    })
    await redisDel(DL.redis, `admin_auth:${_admin.id}`)
    clearCookie(ADMIN_TOKEN_COOKIE)
    return true
}

logout.config = {
    auth: 'required'
}
