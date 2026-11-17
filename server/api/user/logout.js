import { USER_TOKEN_COOKIE } from '#common/constants.js'
import { redisDel } from '#server/utils/redisSafe.js'

export default async function logout(payload, { DL, _user, platform, clearCookie }) {
    await DL.User.updateOne({ id: _user.id }, {
        $set: { lastLogout: new Date() },
        $unset: { [`tokens.${platform}`]: '' }
    })
    await redisDel(DL.redis, `user_auth:${_user.id}`)
    clearCookie(USER_TOKEN_COOKIE)
    return true
}

logout.config = { auth: 'required' }
