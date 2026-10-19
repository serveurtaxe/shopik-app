import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
    DIET_GROUPS,
    DIET_CODE_INDEX,
    selectDietIcons,
    selectFoodSymbols
} from '../../common/components/Nutrition/constants.js'
import { mapDiet, mapNutrients } from '../../server/external/gs1/mapper.js'

const code = (n, name) => ({ code: String(n), name })

describe('selectDietIcons', () => {
    it('maps codes to icons and sorts by group rank', () => {
        const diet = [code(5521, 'טבעוני'), code(5538, 'ללא גלוטן'), code(5510, 'אורגני')]
        const out = selectDietIcons(diet, Infinity)
        assert.deepEqual(out.map(e => e.icon), ['leaf', 'vegan', 'wheatOff'])
        assert.deepEqual(out.map(e => e.rank), [1, 6, 8])
    })

    it('caps the result at count', () => {
        const diet = [code(5521, 'טבעוני'), code(5510, 'אורגני')]
        const out = selectDietIcons(diet, 1)
        assert.equal(out.length, 1)
        assert.equal(out[0].icon, 'leaf')
    })

    it('shows one icon per group even for different codes', () => {
        const out = selectDietIcons([code(5577, 'ללא קמח'), code(5538, 'ללא גלוטן')], Infinity)
        assert.deepEqual(out.map(e => e.icon), ['wheatOff'])
    })

    it('resolves code-less entries by Hebrew name', () => {
        const out = selectDietIcons([{ name: 'ללא גלוטן' }, { name: 'צמחוני' }], Infinity)
        assert.deepEqual(out.map(e => e.icon), ['salad', 'wheatOff'])
    })

    it('skips unknown codes and non-array input', () => {
        assert.deepEqual(selectDietIcons([code(99999, 'x')], Infinity), [])
        assert.deepEqual(selectDietIcons('טבעוני', Infinity), [])
        assert.deepEqual(selectDietIcons(null, Infinity), [])
    })

    it('resolves a known code through the index', () => {
        assert.equal(DIET_CODE_INDEX.get('5510'), DIET_GROUPS.find(g => g.icon === 'leaf'))
    })
})

describe('selectFoodSymbols', () => {
    it('returns green symbol first, then red flags', () => {
        const out = selectFoodSymbols({ positive: true, sugar: true, fat: true })
        assert.deepEqual(out.map(s => s.key), ['positive', 'sugar', 'fat'])
    })

    it('ignores absent flags and bad input', () => {
        assert.deepEqual(selectFoodSymbols({ sodium: true }).map(s => s.key), ['sodium'])
        assert.deepEqual(selectFoodSymbols(null), [])
        assert.deepEqual(selectFoodSymbols({}), [])
    })
})

describe('mapDiet', () => {
    it('maps { code, value } entries to { code, name }', () => {
        const out = mapDiet([
            { value: 'טבעוני', code: '5521' },
            { value: 'ללא גלוטן', code: '5538' }
        ])
        assert.deepEqual(out, [
            { code: '5521', name: 'טבעוני' },
            { code: '5538', name: 'ללא גלוטן' }
        ])
    })

    it('splits code-less entries that pack several claims with |', () => {
        const out = mapDiet([{ value: 'ללא חומרים משמרים|ללא צבעי מאכל' }])
        assert.deepEqual(out, [
            { name: 'ללא חומרים משמרים' },
            { name: 'ללא צבעי מאכל' }
        ])
    })

    it('drops duplicates and blanks, tolerates bad input', () => {
        const out = mapDiet([{ value: 'טבעוני', code: '5521' }, { value: 'dup', code: '5521' }, { value: ' ' }])
        assert.deepEqual(out, [{ code: '5521', name: 'טבעוני' }])
        assert.deepEqual(mapDiet(undefined), [])
        assert.deepEqual(mapDiet('טבעוני'), [])
    })
})

describe('mapNutrients', () => {
    it('flags the red high-in labels and the green symbol', () => {
        const out = mapNutrients({
            Food_Symbol_Red: [
                { code: 'FSR2' }, { code: 'FSR3' }, { code: 'FSR4' }, { code: 'FSR5' }
            ]
        })
        assert.deepEqual(out, { sodium: true, sugar: true, fat: true, positive: true })
    })

    it('ignores FSR1 (no label) and flags alcohol from a percentage', () => {
        assert.deepEqual(mapNutrients({ Food_Symbol_Red: [{ code: 'FSR1' }] }), {})
        assert.deepEqual(mapNutrients({ Alcohol_Percentage_in_Product: '5%' }), { alcohol: true })
        assert.deepEqual(mapNutrients({ Alcohol_Percentage_in_Product: '0' }), {})
    })
})
