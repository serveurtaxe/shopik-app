// .env support for the stress runner and the release gate.
//
// Only STRESS_* (plus SECRET, which the order-flow simulation needs to decrypt
// settings) are read from .env. DB/DB_URI/PRODUCTION are deliberately ignored:
// the runner's production guard compares the stress URI against those, and
// pulling them from .env would make a local run refuse the very database the
// local server is using.
//
// Values already present in the process environment win, matching the usual
// "exported env overrides .env" convention.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ENV_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../..', '.env')

const KEY_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/

export function loadStressEnv(path = ENV_PATH) {
    let text
    try {
        text = readFileSync(path, 'utf8')
    } catch {
        return 0
    }

    let loaded = 0
    for (const line of text.split(/\r?\n/)) {
        if (!line || line.trimStart().startsWith('#')) continue
        const match = KEY_RE.exec(line)
        if (!match) continue
        const [, key, raw] = match
        if (key !== 'SECRET' && !key.startsWith('STRESS_')) continue
        if (process.env[key] !== undefined) continue
        process.env[key] = raw.trim().replace(/^["']|["']$/g, '')
        loaded++
    }
    return loaded
}
