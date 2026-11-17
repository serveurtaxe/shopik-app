// One retry curve for every Redis client in the process.
//
// Each client used to carry its own `if (times > 3) return null`, which told
// ioredis to stop trying for ever: a Redis that came back 10 seconds later
// stayed invisible until the container was redeployed. Retrying forever with a
// capped, jittered backoff is what makes a recovered Redis reconnect by itself.
export const REDIS_CONNECT_TIMEOUT_MS = 2000

export const REDIS_RETRY_MAX_MS = 30_000

export function redisBackoffMs(times) {
    const base = 1000 * 2 ** Math.min(times, 5)
    return Math.min(base, REDIS_RETRY_MAX_MS) + Math.floor(Math.random() * 500)
}
