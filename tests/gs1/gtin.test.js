import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { gtinOf } from '../../server/services/gs1/gtin.js'

describe('GS1 lookup filter', () => {
    it('keeps a valid EAN-13 as is', () => {
        assert.equal(gtinOf('7290010068012'), '7290010068012')
    })

    it('pads a 12-digit UPC to the GTIN GS1 stores it under', () => {
        assert.equal(gtinOf('729000000017'), '0729000000017')
    })

    it('rejects a broken check digit', () => {
        assert.equal(gtinOf('7290010068011'), null)
        assert.equal(gtinOf('7290010068013'), null)
    })

    it('rejects Comax item ids and anything that is not 12 or 13 digits', () => {
        for (const code of ['10068012', '1001004', '1234567890123', '1234', '', null, '7290010068O12'])
            assert.equal(gtinOf(code), null, `${code} is not a GTIN`)
    })

    it('does not ask GS1 about EAN-8 codes', () => {
        assert.equal(gtinOf('96385074'), null)
    })

    it('trims the code before deciding', () => {
        assert.equal(gtinOf(' 7290010068012 '), '7290010068012')
    })
})
