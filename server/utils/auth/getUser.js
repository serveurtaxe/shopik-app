import { USER_TOKEN_COOKIE } from '#common/constants.js'
import getPlatform from '#server/utils/getPlatform.js'
import safeJsonParse from '#common/functions/safeJsonParse.js'
import { redisGet, redisSet } from '#server/utils/redisSafe.js'

export default async function getUser(req, { DL, utils }) {
    const platform = getPlatform(req)
    const token = req.cookies?.[USER_TOKEN_COOKIE]
    const { id } = utils.auth.verifyToken(token)
    const cacheId = `user_auth:${id}`
    let user
    const cached = await redisGet(DL.redis, cacheId)
    if (cached)
        user = safeJsonParse(cached)
    else {
        user = await DL.User.Model.findOne(
            { id },
            { ...DL.User.defaultSelect, tokens: 1 }
        ).lean()
        await redisSet(DL.redis, `user_auth:${id}`, JSON.stringify(user), 'EX', 60 * 60 * 24)
    }
    if (!user)
        throw { status: 401, message: 'Unauthorized' }

    if (user.tokens?.[platform] !== token)
        throw { status: 401, message: 'Unauthorized' }

    delete user.tokens

    return user
}
