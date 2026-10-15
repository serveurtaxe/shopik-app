import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { isComaxDeliveryEnabled } from '../../server/external/comax/utils.js'

const KEY = 'COMAX_DELIVERY_ENABLED'
const prev = process.env[KEY]
afterEach(() => {
    if (prev === undefined) delete process.env[KEY]
    else process.env[KEY] = prev
})

describe('isComaxDeliveryEnabled', () => {
    it('is off when unset', () => {
        delete process.env[KEY]
        assert.equal(isComaxDeliveryEnabled(), false)
    })

    it('is on only for true (case-insensitive)', () => {
        process.env[KEY] = 'true'
        assert.equal(isComaxDeliveryEnabled(), true)
        process.env[KEY] = 'TRUE'
        assert.equal(isComaxDeliveryEnabled(), true)
    })

    it('is off for any other value', () => {
        for (const v of ['false', '0', '1', 'yes', '']) {
            process.env[KEY] = v
            assert.equal(isComaxDeliveryEnabled(), false, `value ${JSON.stringify(v)}`)
        }
    })
})
