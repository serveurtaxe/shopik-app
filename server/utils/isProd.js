// Single definition of "this process is production" for the server side.
//
// Extracted from middleware/security.js so non-middleware code (getClientData
// shipping env.PROD to the browser) can reuse it without importing helmet/cors.
// The semantics are unchanged: NODE_ENV=production, PRODUCTION='true', or any
// other set value of PRODUCTION (Boolean('false') is true, as before).
export const isProdEnv = () =>
    process.env.NODE_ENV === 'production' ||
    process.env.PRODUCTION === 'true' ||
    Boolean(process.env.PRODUCTION)
