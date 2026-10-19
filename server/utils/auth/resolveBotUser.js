/**
 * Resolve a bot-verified user from a userToken (issued by bot/otp_verify).
 * Token-only: the token must be cryptographically valid AND match the
 * latest stored copy (user.tokens.bot), so re-login (or clearing the
 * stored copy) immediately revokes older tokens. Mirrors the web
 * session check in utils/auth/getUser.js.
 * Throws { status: 400/401/403 } on failure.
 */
export default async function resolveBotUser({ DL, utils, domainId, userToken }) {
    if (!userToken) throw { status: 400, message: 'userToken required' }

    let decoded
    try {
        decoded = utils.auth.verifyToken(userToken)
    } catch {
        throw { status: 401, message: 'Invalid user token' }
    }

    // Direct model query with explicit projection: `tokens` is select:false
    // and DL.User.readById cannot retrieve it. No caching — bot volume is
    // low and cache entries must never mix token-bearing/token-less docs.
    const user = await DL.User.Model.findOne(
        { id: decoded.id },
        { _id: 0, tokens: 1, id: 1 }
    ).lean()
    if (!user) throw { status: 401, message: 'User not found' }
    if (!user.tokens?.bot || user.tokens.bot !== userToken)
        throw { status: 401, message: 'Invalid user token' }
    if (domainId && user.domainId && String(user.domainId) !== String(domainId))
        throw { status: 403, message: 'User belongs to a different domain' }

    delete user.tokens
    return user
}
