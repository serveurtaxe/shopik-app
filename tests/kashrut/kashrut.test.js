import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    KASHRUT_CODE_INDEX,
    SUPERVISION_LABELS,
    selectKashrutStamps,
    getSupervisionLabel,
    normalizeKashrut
} from '../../common/components/Kashrut/constants.js'
import { mapKashrut } from '../../server/external/gs1/mapper.js'

const code = (n, name) => ({ code: String(n), name })

describe('selectKashrutStamps', () => {
    it('sorts rabbinates by certificate strength, strongest first', () => {
        const kashrut = {
            rabbinates: [
                code(67093, 'בדצ בית יוסף'),
                code(67085, 'בדצ העדה החרדית'),
                code(67072, 'בדצ מחזיקי הדת')
            ]
        }
        const out = selectKashrutStamps(kashrut, 3)
        assert.deepEqual(out.map(e => e.code), ['67085', '67072', '67093'])
        assert.deepEqual(out.map(e => e.rank), [1, 10, 11])
    })

    it('caps the result at count', () => {
        const kashrut = { rabbinates: [code(67093, 'בית יוסף'), code(67085, 'עדה החרדית')] }
        assert.equal(selectKashrutStamps(kashrut, 1).length, 1)
        assert.equal(selectKashrutStamps(kashrut, 1)[0].code, '67085')
    })

    it('returns every ranked entry when count is Infinity', () => {
        const kashrut = { rabbinates: [code(67093, 'בית יוסף'), code(67085, 'עדה החרדית')] }
        assert.equal(selectKashrutStamps(kashrut, Infinity).length, 2)
    })

    it('sorts unknown codes after known ones, preserving source order', () => {
        const kashrut = {
            rabbinates: [
                code(99999, 'unknown-a'),
                code(67085, 'עדה החרדית'),
                code(88888, 'unknown-b')
            ]
        }
        const out = selectKashrutStamps(kashrut, Infinity)
        assert.deepEqual(out.map(e => e.code), ['67085', '99999', '88888'])
        assert.equal(out[1].rank, Infinity)
    })

    it('drops blank and duplicate codes', () => {
        const kashrut = {
            rabbinates: [code(67085, 'עדה החרדית'), code(67085, 'dup'), { name: ' ' }, {}]
        }
        const out = selectKashrutStamps(kashrut, Infinity)
        assert.equal(out.length, 1)
        assert.equal(out[0].stampCode, '67085')
    })

    it('shares the group stampCode across codes of the same stamp', () => {
        const kashrut = { rabbinates: [code(67068, 'בדצ עדה החרדית')] }
        assert.equal(selectKashrutStamps(kashrut, 1)[0].stampCode, '67085')
    })

    it('prefers the GS1 name, falls back to the config name when absent', () => {
        const withName = selectKashrutStamps({ rabbinates: [code(67085, 'עדה החרדית')] }, 1)
        assert.equal(withName[0].name, 'עדה החרדית')
        const withoutName = selectKashrutStamps({ rabbinates: [{ code: '67085' }] }, 1)
        assert.equal(withoutName[0].name, KASHRUT_CODE_INDEX.get('67085').name)
    })

    it('keeps only entries with an image when hasImage is provided', () => {
        const kashrut = { rabbinates: [code(67085, 'a'), code(67093, 'b')] }
        const out = selectKashrutStamps(kashrut, 2, { hasImage: c => c === '67093' })
        assert.deepEqual(out.map(e => e.code), ['67093'])
    })

    it('treats a legacy string kashrut as empty', () => {
        assert.deepEqual(selectKashrutStamps('פרווה / בדצ העדה החרדית', 1), [])
    })
})

describe('normalizeKashrut', () => {
    it('coerces the object shape and ignores bad input', () => {
        assert.deepEqual(normalizeKashrut(null), { rabbinates: [], supervisionType: '' })
        assert.deepEqual(normalizeKashrut('str'), { rabbinates: [], supervisionType: '' })
        assert.deepEqual(
            normalizeKashrut({ rabbinates: [{ code: '1' }], supervisionType: 183 }),
            { rabbinates: [{ code: '1' }], supervisionType: '183' }
        )
    })
})

describe('getSupervisionLabel', () => {
    it('maps supervision codes to Hebrew labels', () => {
        assert.equal(getSupervisionLabel({ supervisionType: '183' }), SUPERVISION_LABELS[183])
        assert.equal(getSupervisionLabel({ supervisionType: '181' }), SUPERVISION_LABELS[181])
        assert.equal(getSupervisionLabel({ supervisionType: '180' }), '')
        assert.equal(getSupervisionLabel({ supervisionType: '999' }), '')
        assert.equal(getSupervisionLabel(null), '')
    })
})

describe('mapKashrut', () => {
    it('maps rabbinate + supervision to the object shape', () => {
        const out = mapKashrut({
            Rabbinate: [{ value: 'בדצ העדה החרדית', code: '67085' }],
            Kosher_Supervision_Type: [{ value: 'פרווה', code: '183' }]
        })
        assert.deepEqual(out.kashrut, {
            rabbinates: [{ code: '67085', name: 'בדצ העדה החרדית' }],
            supervisionType: '183'
        })
    })

    it('drops blank and duplicate rabbinate entries', () => {
        const out = mapKashrut({
            Rabbinate: [
                { value: 'בדצ העדה החרדית', code: '67085' },
                { value: 'dup', code: '67085' },
                { value: ' ' },
                {}
            ]
        })
        assert.deepEqual(out.kashrut.rabbinates, [{ code: '67085', name: 'בדצ העדה החרדית' }])
    })

    it('keeps a value-only rabbinate for text fallback', () => {
        const out = mapKashrut({ Rabbinate: [{ value: 'רבנות אחרת' }] })
        assert.deepEqual(out.kashrut.rabbinates, [{ name: 'רבנות אחרת' }])
    })

    it('flags kosher-for-passover', () => {
        const out = mapKashrut({ Kosher_for_Passover: [{ value: 'כשר לפסח' }] })
        assert.equal(out.passoverKashrut, 'kosher')
    })

    it('returns nothing when there is no kashrut content', () => {
        assert.deepEqual(mapKashrut(undefined), {})
        assert.deepEqual(mapKashrut({ Rabbinate: [{ value: ' ' }] }), {})
    })
})
