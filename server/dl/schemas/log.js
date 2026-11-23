import uid from '#common/functions/uid.js'
import pkg from '#package.json' with { type: 'json' }
const appVersion = pkg?.version || 'unknown'

function truncateLogData(data, maxBytes = 60000) {
    if (data == null) return data
    try {
        const str = JSON.stringify(data)
        if (Buffer.byteLength(str, 'utf8') <= maxBytes) return data
        return str.slice(0, Math.floor(maxBytes * 0.9)) + '...[truncated]'
    } catch {
        return undefined
    }
}

const constants = {
    STATUS: {
        PENDING: 'pending',
        SUCCESS: 'success',
        ERROR: 'error'
    },
    ACTOR: {
        ADMIN: 'admin',
        USER: 'user',
        API: 'api',
        ANONYMOUS: 'anonymous',
        SYSTEM: 'system',
        BOT: 'bot'
    },
    DIRECTION: {
        IN: 'in',
        OUT: 'out'
    }
}

const logSchema = {
    action: {
        type: String,
        required: true,
        filter: true
    },
    actor: {
        type: {
            type: String,
            enum: Object.values(constants.ACTOR),
            filter: true,
            default: constants.ACTOR.ANONYMOUS
        },
        id: {
            type: String,
            filter: true
        },
        name: {
            type: String,
            filter: true
        }
    },
    direction: {
        type: String,
        default: constants.DIRECTION.IN
    },
    appVersion: String,
    requestId: {
        type: String,
        unique: true,
        filter: true
    },
    requestTime: Date,
    responseTime: Date,
    duration: Number,
    ip: {
        type: String,
        filter: true
    },
    userAgent: { type: String },
    status: {
        type: String,
        enum: Object.values(constants.STATUS),
        default: constants.STATUS.PENDING,
        filter: true
    },
    data: {
        type: {},
        validate: {
            validator: function (v) {
                if (v == null) return true
                try {
                    const jsonString = JSON.stringify(v)
                    return Buffer.byteLength(jsonString, 'utf8') <= 65536
                } catch (err) {
                    return false
                }
            },
            message: 'Log data payload exceeds 64KB limit or contains circular references.'
        }
    }
}
const HOUR = 60 * 60
const DAY = 24 * HOUR
const index = [
    // Sort index for the admin Logs page
    { createdAt: 1, id: -1 },
    // Expiry has to be its own single-field index 
    [
        { createdAt: 1 },
        { expireAfterSeconds: process.env.PRODUCTION ? DAY : 6 * HOUR }
    ],
    { duration: 1 }
]

const methods = Log => {
    function start(logData) {
        const requestTime = new Date
        const requestStart = performance.now()
        if (!logData.requestId)
            logData.requestId = uid(16)

        const logBody = {
            requestTime,
            appVersion,
            ...logData
        }
        // Request bodies can be huge (e.g. base64 image uploads) — truncate to
        // fit the 64KB data validator. Logging must never fail the request.
        if (logBody.data)
            logBody.data = truncateLogData(logBody.data)
        const logPromise = Log.create(logBody).catch(() => null)
        let actorData
        async function end(updateData) {
            const responseTime = new Date
            const requestEnd = performance.now()
            const duration = +(requestEnd - requestStart).toFixed(4)
            const log = await logPromise
            if (!log) return
            const update = {
                responseTime,
                duration,
                ...updateData
            }
            if (actorData)
                update.actor = actorData
            try { await Log.updateOne({ id: log.id }, update) } catch { }
        }
        async function success(responseData) {
            const update = {
                status: constants.STATUS.SUCCESS,
                ['data.response']: truncateLogData(responseData)
            }

            return end(update)
        }
        async function error(responseData) {
            const update = {
                status: constants.STATUS.ERROR,
                ['data.response']: truncateLogData(responseData)
            }
            return end(update)
        }
        function actor(data) {
            actorData = data
        }

        return {
            success,
            error,
            actor,
            end
        }
    }

    // One-shot insert for request logs: the router builds the finished document
    // after the response, so there is no pending insert to update. Outbound logs
    // (sms, comax) keep using start() + success()/error().
    function record(logData) {
        const logBody = {
            requestTime: new Date,
            appVersion,
            ...logData
        }
        if (logBody.data)
            logBody.data = truncateLogData(logBody.data)
        return Log.create(logBody).catch(() => null)
    }

    return { start, record }
}

export const meta = {
    index,
    constants,
    noActive: true,
    methods,
    timestamps: { createdAt: true, updatedAt: false }
}

export default logSchema