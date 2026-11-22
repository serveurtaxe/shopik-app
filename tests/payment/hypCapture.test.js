import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import hypFactory, { applyChargeInstallments } from '../../server/external/hyp/index.js'

const envKeys = ['HYP_MASOF', 'HYP_KEY', 'HYP_PASSP', 'HYP_BASE_URL']
const savedEnv = Object.fromEntries(envKeys.map(k => [k, process.env[k]]))

const order = {
    id: 'o1',
    number: 100019,
    name: { first: 'Dana', last: 'Levi' },
    payment: {
        cardToken: 'tok-123',
        cardExpiry: '2912',
        authCode: 'A1',
        providerUid: 'UID1',
        authorizedAmount: 300,
        payments: 4
    }
}

let urls
let originalFetch

beforeEach(() => {
    process.env.HYP_MASOF = '0086246125'
    process.env.HYP_KEY = 'api-key'
    process.env.HYP_PASSP = 'api-pass'
    process.env.HYP_BASE_URL = 'https://pay.hyp.co.il/p/'
    urls = []
    originalFetch = global.fetch
    global.fetch = async (url) => {
        urls.push(url)
        return { text: async () => 'Id=404274302&CCode=0&Amount=300' }
    }
})

afterEach(() => {
    global.fetch = originalFetch
    for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k]
        else process.env[k] = savedEnv[k]
    }
})

function lastParams() {
    return new URL(urls.at(-1)).searchParams
}

describe('action=soft installments', () => {
    it('applies only the selected count, with regular (no-interest) installments', () => {
        const params = applyChargeInstallments(new URLSearchParams(), 4)
        assert.equal(params.get('Tash'), '4')
        assert.equal(params.get('tashType'), '1')
    })

    it('does not split a charge when the customer picked one payment', () => {
        const params = applyChargeInstallments(new URLSearchParams(), 1)
        assert.equal(params.has('Tash'), false)
        assert.equal(params.has('tashType'), false)
    })

    it('clamps invalid counts to a single payment', () => {
        assert.equal(applyChargeInstallments(new URLSearchParams(), undefined).has('Tash'), false)
        assert.equal(applyChargeInstallments(new URLSearchParams(), 0).has('Tash'), false)
        assert.equal(applyChargeInstallments(new URLSearchParams(), 'abc').has('Tash'), false)
        assert.equal(applyChargeInstallments(new URLSearchParams(), 99).get('Tash'), '36')
    })

    it('sends the chosen installments on the J4 capture', async () => {
        const hyp = hypFactory({ DL: null })
        await hyp.capture({ order, amount: 300, payments: 4 })
        const params = lastParams()
        assert.equal(params.get('action'), 'soft')
        assert.equal(params.get('Tash'), '4')
        assert.equal(params.get('tashType'), '1')
        assert.equal(params.get('inputObj.originalUid'), 'UID1')
        assert.equal(params.get('inputObj.authorizationCodeManpik'), '7')
    })

    it('sends the chosen installments on a token charge (overflow / delta)', async () => {
        const hyp = hypFactory({ DL: null })
        await hyp.chargeToken({ order, amount: 40, payments: 4 })
        const params = lastParams()
        assert.equal(params.get('Tash'), '4')
        assert.equal(params.get('tashType'), '1')
        assert.equal(params.has('inputObj.originalUid'), false)
    })

    it('keeps a single payment when the authorization has no Payments value', async () => {
        const hyp = hypFactory({ DL: null })
        await hyp.capture({ order: { ...order, payment: { ...order.payment, payments: undefined } }, amount: 300 })
        const params = lastParams()
        assert.equal(params.has('Tash'), false)
        assert.equal(params.has('tashType'), false)
    })

    it('propagates installments to both legs of an over-capture split', async () => {
        const hyp = hypFactory({ DL: null })
        const split = await hyp.captureOverCaptureSplit({ order, captureAmount: 340, payments: 4 })
        assert.equal(split.overflow, 40)
        assert.equal(urls.length, 2)
        for (const url of urls) {
            const params = new URL(url).searchParams
            assert.equal(params.get('Tash'), '4')
            assert.equal(params.get('tashType'), '1')
        }
    })
})
