import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import callback from '../../server/api/payment/hyp/callback.js'

function buildInfo({ order, query, txns = [], updates = [], timeline = [], updateError = null, existingTxn = null }) {
    const sent = []
    const res = {
        code: undefined,
        status(code) {
            this.code = code
            return this
        },
        type() {
            return this
        },
        send(html) {
            sent.push(html)
            return this
        }
    }

    return {
        DL: {
            Order: {
                constants: { ORDER_STATUS: { CART: 'cart', PAID: 'paid' } },
                readOne: async () => order,
                updateOne: async (filter, update) => {
                    if (updateError) throw updateError
                    updates.push(update)
                    return { ...order, ...update }
                }
            },
            PaymentTransaction: {
                constants: {
                    TRANSACTION_KIND: { AUTH: 'auth', CAPTURE: 'capture', REFUND: 'refund', CANCEL: 'cancel' },
                    TRANSACTION_STATUS: { PENDING: 'pending', SUCCESS: 'success', FAILED: 'failed' }
                },
                readOne: async () => existingTxn,
                create: async (doc) => {
                    txns.push(doc)
                    return doc
                }
            },
            Timeline: {
                constants: {
                    EVENT_TYPES: { PAYMENT: 'payment', ORDER_STATUS_UPDATE: 'order_status_update' }
                }
            }
        },
        external: {
            hyp: {
                verifyRedirect: async () => ({ CCode: 0 }),
                getToken: async () => ({ CCode: 0, Token: 'tok-123', Tokef: '2912' }),
                cardBrandName: () => 'Visa',
                ccodeMessage: (code) => `Hyp error ${code}`
            }
        },
        utils: {
            data: {
                timeline: {
                    record: async (event) => {
                        timeline.push(event)
                        return event
                    }
                },
                orderSms: { sendOrderStageSms: async () => ({}) }
            }
        },
        query,
        req: { originalUrl: `/api/payment/hyp/callback?${new URLSearchParams(query).toString()}` },
        res,
        sent
    }
}

const order = {
    id: 'o1',
    number: 100019,
    status: 'cart',
    userId: 'u1',
    domainId: 'd1',
    storeId: 's1',
    finalSumWithShipping: 300,
    name: { first: 'Dana', last: 'Levi' },
    phone: '0501234567',
    email: 'dana@example.com'
}

const query = {
    Order: '100019',
    Id: 'txn-1',
    CCode: '0',
    Amount: '300',
    ACode: 'A1',
    UID: 'UID1',
    UserId: '000000000',
    L4digit: '1234',
    Brand: '2',
    Payments: '3',
    Sign: 'sig'
}

describe('payment/hyp/callback payments', () => {
    it('stores the customer-selected Payments count on the order and transaction', async () => {
        const txns = []
        const updates = []
        const timeline = []
        const info = buildInfo({ order, query, txns, updates, timeline })

        await callback({}, info)

        assert.equal(info.res.code, 200)
        const auth = txns.find(t => t.status === 'success')
        assert.equal(auth?.payments, 3)
        const paymentUpdate = updates.find(u => u.payment)
        assert.equal(paymentUpdate?.payment?.payments, 3)
        const authorizedEvent = timeline.find(e => e?.context?.step === 'payment_authorized')
        assert.equal(authorizedEvent?.context?.payments, 3)
    })

    it('leaves payments undefined when Hyp returns no Payments value', async () => {
        const txns = []
        const updates = []
        const info = buildInfo({
            order,
            query: { ...query, Payments: undefined },
            txns,
            updates
        })

        await callback({}, info)

        const auth = txns.find(t => t.status === 'success')
        assert.equal(auth?.payments, undefined)
        const paymentUpdate = updates.find(u => u.payment)
        assert.equal(paymentUpdate?.payment?.payments, undefined)
    })

    it('reports failure instead of a fake success when the order update fails', async () => {
        const timeline = []
        const info = buildInfo({
            order,
            query,
            txns: [],
            updates: [],
            timeline,
            updateError: { message: 'mongo write error' }
        })

        await callback({}, info)

        // the authorization is still recorded — the transaction is the money record
        assert.equal(info.res.code, 400)
        assert.ok(info.sent[0].includes("ok:false"))
        const failure = timeline.find(e => e?.context?.step === 'order_status_update_failed')
        assert.equal(failure?.outcome?.success, false)
    })

    it('repairs a paid-but-still-cart order from the stored transaction', async () => {
        const txns = []
        const updates = []
        const existingTxn = {
            status: 'success',
            kind: 'auth',
            providerTxnId: 'txn-1',
            authCode: 'A1',
            providerUid: 'UID1',
            providerPayerId: '000000000',
            cardToken: 'tok-123',
            cardExpiry: '2912',
            last4digits: '1234',
            cardCompany: 'Visa',
            payments: 3,
            terminalId: 't1',
            amount: 300
        }
        const info = buildInfo({ order, query, txns, updates, existingTxn })

        await callback({}, info)

        assert.equal(info.res.code, 200)
        const update = updates.find(u => u.status === 'paid')
        assert.equal(update?.payment?.providerTxnId, 'txn-1')
        assert.equal(update?.payment?.cardToken, 'tok-123')
        // no duplicate authorization transaction created
        assert.equal(txns.length, 0)
    })
})
