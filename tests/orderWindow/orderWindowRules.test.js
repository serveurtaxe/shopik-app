import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    WINDOW_CHANGE_STATUSES,
    canChangeOrderWindow,
    isOrderCaptured,
    isWindowFull
} from '../../common/functions/orderWindow.js'
import hebrew from '../../common/texts/hebrew.json' with { type: 'json' }

describe('admin window-change eligibility', () => {
    it('allows active orders that are not captured', () => {
        for (const status of WINDOW_CHANGE_STATUSES) {
            assert.equal(canChangeOrderWindow({ status, payment: {} }), true)
        }
    })

    it('blocks orders with a capture transaction', () => {
        for (const status of WINDOW_CHANGE_STATUSES) {
            const order = { status, payment: { captureProviderTxnId: 'txn-1' } }
            assert.equal(isOrderCaptured(order), true)
            assert.equal(canChangeOrderWindow(order), false)
        }
    })

    it('blocks packed (always captured), cart, paid-edit and closed statuses', () => {
        for (const status of ['packed', 'cart', 'paid-edit', 'shipped', 'done', 'canceled', 'failed']) {
            assert.equal(canChangeOrderWindow({ status, payment: {} }), false)
        }
    })
})

describe('window state translations', () => {
    it('has a Hebrew label for every picker state', () => {
        for (const key of [
            'available',
            'past',
            'full',
            'almost full',
            'closed',
            'chosen window',
            'windows_full',
            'windows_almost_full',
            'windows_closed_window'
        ]) {
            assert.ok(hebrew.texts[key], `missing translation for ${key}`)
        }
    })
})

describe('window capacity state', () => {
    it('is full when the global counter reaches maxCapacity', () => {
        assert.equal(isWindowFull({ totalOrders: 5, maxCapacity: 5 }), true)
        assert.equal(isWindowFull({ totalOrders: 6, maxCapacity: 5 }), true)
    })

    it('is full when the order group bucket reaches its capacity', () => {
        assert.equal(isWindowFull(
            { totalOrders: 1, maxCapacity: 10 },
            { count: 3, capacity: 3 }
        ), true)
    })

    it('is not full while both counters have room', () => {
        assert.equal(isWindowFull(
            { totalOrders: 1, maxCapacity: 10 },
            { count: 1, capacity: 3 }
        ), false)
        assert.equal(isWindowFull({ totalOrders: 1, maxCapacity: 10 }), false)
    })
})
