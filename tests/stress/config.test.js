import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../../scripts/stress/config.js'

const saved = process.env.STRESS_ID_NUM
afterEach(() => {
    if (saved === undefined) delete process.env.STRESS_ID_NUM
    else process.env.STRESS_ID_NUM = saved
})

describe('stress config', () => {
    it('reads STRESS_ID_NUM, but --id-num wins', () => {
        process.env.STRESS_ID_NUM = '111'
        assert.equal(parseArgs(['--target', 'local']).idNum, '111')
        assert.equal(parseArgs(['--target', 'local', '--id-num', '222']).idNum, '222')
    })

    it('treats an empty STRESS_ID_NUM as unset', () => {
        process.env.STRESS_ID_NUM = ''
        assert.equal(parseArgs(['--target', 'local']).idNum, null)
    })
})
