import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'fixtures', 'stream-memory.mjs')

describe('comax streaming memory', () => {
    it('does not keep the catalog on the heap while streaming it', () => {
        const result = spawnSync(process.execPath, ['--expose-gc', fixture, '60000'], { encoding: 'utf8' })

        assert.equal(result.status, 0, result.stderr)

        const stats = JSON.parse(result.stdout.trim().split('\n').pop())

        assert.equal(stats.blocks, 60000)
        assert.ok(stats.docBytes > 5_000_000, `expected a multi-MB catalog, got ${stats.docBytes}`)
        // A whole-document parse of this catalog needs several times its size
        // on the heap (string + object tree + mapped array). Streaming must
        // keep the live set flat.
        assert.ok(
            stats.growth < stats.docBytes / 8,
            `heap grew ${stats.growth} bytes for a ${stats.docBytes} byte catalog`
        )
    })
})
