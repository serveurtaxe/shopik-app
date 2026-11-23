import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStressEnv } from '../../scripts/stress/env.js'

// These are the real names the loader must (and must not) touch.
const MANAGED = ['STRESS_TEST_ONE', 'STRESS_TEST_TWO', 'SECRET', 'DB', 'DB_URI', 'PRODUCTION']
const saved = Object.fromEntries(MANAGED.map(key => [key, process.env[key]]))
const dirs = []

function clear() {
    for (const key of MANAGED) delete process.env[key]
}

function tempEnv(lines) {
    const dir = mkdtempSync(join(tmpdir(), 'stress-env-'))
    dirs.push(dir)
    const file = join(dir, '.env')
    writeFileSync(file, lines.join('\n'))
    return file
}

afterEach(() => {
    clear()
    for (const key of MANAGED) {
        if (saved[key] !== undefined) process.env[key] = saved[key]
    }
    while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true })
})

describe('loadStressEnv', () => {
    it('loads STRESS_* and SECRET, but never DB/DB_URI/PRODUCTION', () => {
        clear()
        const file = tempEnv([
            '# a comment',
            'STRESS_TEST_ONE=hello',
            'SECRET="quoted-secret"',
            'DB=mongodb://localhost/app',
            'DB_URI=mongodb://localhost/app2',
            'PRODUCTION=1'
        ])

        assert.equal(loadStressEnv(file), 2)
        assert.equal(process.env.STRESS_TEST_ONE, 'hello')
        assert.equal(process.env.SECRET, 'quoted-secret')
        assert.equal(process.env.DB, undefined)
        assert.equal(process.env.DB_URI, undefined)
        assert.equal(process.env.PRODUCTION, undefined)
    })

    it('does not override an exported value', () => {
        clear()
        process.env.STRESS_TEST_TWO = 'from-shell'
        const file = tempEnv(['STRESS_TEST_TWO=from-env', 'STRESS_TEST_ONE=x'])

        assert.equal(loadStressEnv(file), 1)
        assert.equal(process.env.STRESS_TEST_TWO, 'from-shell')
        assert.equal(process.env.STRESS_TEST_ONE, 'x')
    })

    it('returns 0 when .env is missing', () => {
        assert.equal(loadStressEnv(join(tmpdir(), 'definitely-not-a-stress-env')), 0)
    })
})
