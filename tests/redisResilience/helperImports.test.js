import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// A call site that uses a redisSafe helper without importing it boots fine and
// only throws `... is not defined` when the route runs — admin/current_store.js
// did exactly that, which broke switching store on the ops page. The helpers are
// read from the module itself, so a new helper is covered without editing here.
const SERVER_DIR = fileURLToPath(new URL('../../server/', import.meta.url))
const HELPER_FILE = join(SERVER_DIR, 'utils', 'redisSafe.js')

const jsFiles = (dir, out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) jsFiles(full, out)
        else if (entry.name.endsWith('.js')) out.push(full)
    }
    return out
}

// Comments and literals can name a helper without calling it.
const codeOnly = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/`[\s\S]*?`/g, '``')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/"[^"\n]*"/g, '""')

describe('redisSafe call sites', () => {
    it('import every helper they call', async () => {
        const helpers = Object.keys(await import('../../server/utils/redisSafe.js'))
        const offenders = []

        for (const file of jsFiles(SERVER_DIR)) {
            if (file === HELPER_FILE) continue
            const src = readFileSync(file, 'utf8')
            const code = codeOnly(src)

            const called = helpers
                // A dotted call (`redis.del`) or a property name is not a helper call.
                .filter(helper => new RegExp(`(^|[^\\w$.])${helper}\\s*\\(`, 'm').test(code))
                // Only suspicious when the file does not define that name itself.
                .filter(helper => !(new RegExp(`(function|const|let|var)\\s+${helper}\\b`, 'm').test(code)))
            if (!called.length) continue

            // Any import line carrying the name counts: some helpers reach a call
            // site through a re-export (scanDel via utils/data/displayBlocks.js).
            const imported = called.every(helper =>
                new RegExp(`import\\s+[^\\n]*\\b${helper}\\b[^\\n]*\\bfrom\\b`, 'm').test(src))
            if (!imported)
                offenders.push(`${relative(SERVER_DIR, file)} calls ${called.join(', ')} without importing it`)
        }

        assert.deepEqual(offenders, [])
    })
})
