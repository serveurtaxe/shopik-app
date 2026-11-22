import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { imagesEligibility, parkReason } from '../../server/services/gs1/enrich.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-11-22T12:00:00Z').getTime()

describe('imagesEligibility', () => {
    it('takes enriched docs with media that were never attempted or are past the window', () => {
        assert.deepEqual(imagesEligibility({ now: NOW }), {
            status: 'enriched',
            assetCount: { $gt: 0 },
            imagesDone: { $ne: true },
            $or: [
                { imagesRetriedAt: { $exists: false } },
                { imagesRetriedAt: { $lte: new Date(NOW - 14 * DAY) } }
            ],
            imagesRetryReason: { $ne: 'no-account' }
        })
    })

    it('honours the retry window', () => {
        const filter = imagesEligibility({ now: NOW, retryDays: 3 })
        assert.deepEqual(filter.$or[1].imagesRetriedAt.$lte, new Date(NOW - 3 * DAY))
    })

    it('reads the window from GS1_IMAGES_RETRY_DAYS', () => {
        const previous = process.env.GS1_IMAGES_RETRY_DAYS
        process.env.GS1_IMAGES_RETRY_DAYS = '30'
        try {
            assert.deepEqual(imagesEligibility({ now: NOW }).$or[1].imagesRetriedAt.$lte, new Date(NOW - 30 * DAY))
        } finally {
            if (previous === undefined) delete process.env.GS1_IMAGES_RETRY_DAYS
            else process.env.GS1_IMAGES_RETRY_DAYS = previous
        }
    })

    it('force ignores the park window and imagesDone (manual backfill)', () => {
        assert.deepEqual(imagesEligibility({ force: true, now: NOW }), {
            status: 'enriched',
            assetCount: { $gt: 0 }
        })
    })

    it('a single-barcode probe ignores the park window: the answer is about GS1, not the clock', () => {
        const filter = imagesEligibility({ barcode: '7290119374953', now: NOW })
        assert.equal(filter.barcode, '7290119374953')
        assert.equal(filter.$or, undefined)
        assert.equal(filter.imagesRetryReason, undefined)
        assert.deepEqual(filter.imagesDone, { $ne: true })
    })

    it('never retries a no-account answer automatically', () => {
        assert.deepEqual(imagesEligibility({ now: NOW }).imagesRetryReason, { $ne: 'no-account' })
    })
})

describe('parkReason', () => {
    it("tags GS1's per-account 400 as no-account", () => {
        const error = Object.assign(new Error('GS1 400 not in our GS1 account: Bad Request'), { notFound: true })
        assert.equal(parkReason(error), 'no-account')
    })

    it('treats everything else as a retryable no-zip', () => {
        assert.equal(parkReason(new Error('GS1 zip corrupt')), 'no-zip')
        assert.equal(parkReason(undefined), 'no-zip')
    })
})
