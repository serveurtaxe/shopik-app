import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    MAX_LOGGED_RESPONSE_BYTES,
    shouldLogRequest,
    summarizeLogValue
} from '../../server/utils/requestLog.js'
import { isReadOnlyRoute } from '../../server/utils/routeKind.js'

describe('isReadOnlyRoute', () => {
    it('recognises reads used by the request-log sampler', () => {
        for (const route of [
            'product/get', 'product/search', 'menu/get', 'category/tree',
            'category/export', 'display_block/carousel', 'comax_product/sales_window',
            'order/mine', 'notifications/counts'
        ]) assert.equal(isReadOnlyRoute(route), true, route)
    })

    it('never treats a mutation or auth route as a read', () => {
        for (const route of [
            'product/update', 'category/update', 'category/reorder',
            'comax_product/sync', 'comax_sale/sync', 'user/login',
            'user/register', 'bot/order/create'
        ]) assert.equal(isReadOnlyRoute(route), false, route)
    })

    it('handles the leading slash the router passes', () => {
        assert.equal(isReadOnlyRoute('/order/mine'), true)
        assert.equal(isReadOnlyRoute('/payment/refunds'), true)
        assert.equal(isReadOnlyRoute('/display_block/categories'), true)
        assert.equal(isReadOnlyRoute('/product/update'), false)
    })
})

describe('summarizeLogValue', () => {
    it('keeps arrays as a length marker', () => {
        assert.equal(summarizeLogValue([1, 2, 3]), '[3 elements]')
    })

    it('keeps a small object verbatim', () => {
        const value = { id: 'a', count: 2 }
        assert.deepEqual(summarizeLogValue(value), value)
    })

    it('omits a large object but reports its size and keys', () => {
        const value = { csv: 'x'.repeat(MAX_LOGGED_RESPONSE_BYTES), rows: 10 }
        const summary = summarizeLogValue(value)
        assert.equal(summary.omitted, true)
        assert.ok(summary.bytes > MAX_LOGGED_RESPONSE_BYTES)
        assert.deepEqual(summary.keys, ['csv', 'rows'])
    })

    it('omits a large string and handles circular values', () => {
        assert.equal(summarizeLogValue('x'.repeat(MAX_LOGGED_RESPONSE_BYTES + 1)).omitted, true)
        const circular = {}
        circular.self = circular
        assert.deepEqual(summarizeLogValue(circular), { omitted: true })
    })
})

describe('shouldLogRequest', () => {
    const read = { route: 'product/get', httpStatus: 200, durationMs: 10 }

    it('always logs mutations, errors and slow requests', () => {
        assert.equal(shouldLogRequest({ ...read, route: 'product/update', sampleRate: 0, random: () => 0.99 }), true)
        assert.equal(shouldLogRequest({ ...read, httpStatus: 500, sampleRate: 0, random: () => 0.99 }), true)
        assert.equal(shouldLogRequest({ ...read, durationMs: 800, slowMs: 500, sampleRate: 0, random: () => 0.99 }), true)
    })

    it('samples successful reads', () => {
        assert.equal(shouldLogRequest({ ...read, sampleRate: 0.1, random: () => 0.05 }), true)
        assert.equal(shouldLogRequest({ ...read, sampleRate: 0.1, random: () => 0.5 }), false)
        assert.equal(shouldLogRequest({ ...read, sampleRate: 0, random: () => 0 }), false)
        assert.equal(shouldLogRequest({ ...read, sampleRate: 1, random: () => 0.999 }), true)
    })

    it('samples the router form of an exact-route read', () => {
        assert.equal(shouldLogRequest({
            route: '/order/mine', httpStatus: 200, durationMs: 10, sampleRate: 0.1, random: () => 0.5
        }), false)
    })
})
