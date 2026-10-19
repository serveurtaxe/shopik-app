/**
 * Drops blank values from a GS1 payload before it is stored.
 *
 * The supplier sends every field of every section, including the ones they
 * have no data for — a typical product carries ~130 empty strings plus a
 * handful of wholly empty sections. In BSON a key costs a type byte plus its
 * name, so those blanks are roughly a quarter of the stored bytes. Pruning
 * them is safe because every consumer of a missing key already treats it as
 * empty (see mapper.js guards and the empty-tolerant gs1Text/nutritionPairs
 * helpers on the storefront).
 *
 * Only '' and null count as blank, plus containers that end up empty as a
 * result. 0, false and '0' are real values and are kept, as is any string
 * that merely contains whitespace.
 *
 * Returns a new structure; the input is never mutated. Returns undefined when
 * nothing survives (an empty object, an empty array, or a blank leaf) so
 * callers can drop the key in a single check.
 */
export function pruneEmpty(value) {
    if (Array.isArray(value)) {
        const kept = []
        for (const entry of value) {
            const pruned = pruneEmpty(entry)
            if (pruned !== undefined) kept.push(pruned)
        }
        return kept.length ? kept : undefined
    }

    if (value !== null && typeof value === 'object') {
        const out = {}
        for (const [key, entry] of Object.entries(value)) {
            const pruned = pruneEmpty(entry)
            if (pruned !== undefined) out[key] = pruned
        }
        return Object.keys(out).length ? out : undefined
    }

    return value == null || value === '' ? undefined : value
}

export default pruneEmpty