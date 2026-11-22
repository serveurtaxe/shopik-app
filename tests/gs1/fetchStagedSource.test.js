import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { zipSync, unzipSync } from 'fflate'
import { fetchStagedSource } from '../../server/services/gs1/enrich.js'
import { isZipBuffer, zipEntryBasenames } from '../../server/services/gs1/images.js'

// A raw JPEG: magic bytes plus filler, long enough for the magic sniff.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(48, 3)])
const MAIN = '367538_7290119374953.jpg'

const makeZip = files => Buffer.from(zipSync(Object.fromEntries(
    Object.entries(files).map(([name, bytes]) => [name, new Uint8Array(bytes)])
)))

// getMediaZip(type) → whatever the fake returns for that type; null = GS1 has
// no media for that type (404, as prod answers for MK/HE on most products).
const external = answer => ({ gs1: { getMediaZip: async (_barcode, opts) => answer(opts?.type ?? null) } })

describe('fetchStagedSource', () => {
    it('wraps a bare image from media=all into a one-entry zip named after the main', async () => {
        // Prod shape: type=MK and type=HE answer nothing, media=all returns the
        // hero JPEG unarchived. Unwrapped, this is what made phase 3 unzip a JPEG
        // and fail every night.
        const res = await fetchStagedSource(external(type => type ? null : JPEG), '7290119374953', MAIN)

        assert.ok(res, 'a single image must still count as a source')
        assert.equal(res.via, 'media=all (single)')
        assert.ok(isZipBuffer(res.buffer), 'phase 3 must receive a zip')
        assert.deepEqual([...zipEntryBasenames(res.buffer)], [MAIN])
        assert.deepEqual([...unzipSync(new Uint8Array(res.buffer))[MAIN]], [...JPEG])
    })

    it('returns a media=all zip untouched when it carries the main', async () => {
        const zip = makeZip({ [MAIN]: JPEG, 'alt.jpg': PNG })
        const res = await fetchStagedSource(external(type => type ? null : zip), '7290119374953', MAIN)

        assert.equal(res.via, 'media=all')
        assert.equal(res.buffer, zip)
    })

    it('still wraps a single-image type=HE answer', async () => {
        const res = await fetchStagedSource(external(type => type === 'HE' ? PNG : null), '7290119374953', MAIN)

        assert.equal(res.via, 'type=HE (single)')
        assert.ok(isZipBuffer(res.buffer))
    })

    it('returns null when GS1 has no media at all', async () => {
        assert.equal(await fetchStagedSource(external(() => null), '7290119374953', MAIN), null)
    })

    it('leaves an unrecognisable body unwrapped for the launcher guard to reject', async () => {
        // type= values GS1 does not know come back HTTP 200 with a short JSON
        // error body; media=all must not turn that into something stageable.
        const body = Buffer.from('{"error":"invalid media type"}')
        const res = await fetchStagedSource(external(type => type ? null : body), '7290119374953', MAIN)

        assert.equal(res.via, 'media=all')
        assert.equal(isZipBuffer(res.buffer), false)
    })
})
