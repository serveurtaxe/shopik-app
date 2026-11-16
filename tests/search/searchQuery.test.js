import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import searchFactory from '../../server/dl/defaults/search.js'

// Product-like model: tiered prefix/regular/fuzzy config, several search fields.
function makeProductModel(searchBoost) {
    const calls = {}
    const Model = {
        getSearchIndexName: () => 'products_search',
        searchFields: { name: 30, keywords: 2, 'category.title': 5 },
        searchPrefixFields: { name: 100 },
        searchFuzzyFields: { name: 3 },
        defaultSelect: { id: 1, name: 1 },
        defaultSort: {},
        aggregate: async (pipe) => {
            calls.pipe = pipe
            return []
        }
    }
    if (searchBoost) Model.searchBoost = searchBoost
    return { Model, calls }
}

const searchStage = calls => calls.pipe[0].$search
const clauseQueries = group => group.compound.should.map(c => c.autocomplete?.query ?? c.wildcard?.query)

describe('dl search query', () => {
    it('matches the full phrase against keyword-analyzed name as a starts-with query', async () => {
        const { Model, calls } = makeProductModel()
        await searchFactory(Model)('בשר טחון')

        const { compound } = searchStage(calls)
        const [phraseGroup, wordGroup] = compound.should

        assert.equal(compound.minimumShouldMatch, 1)
        assert.equal(compound.must, undefined)
        assert.equal(compound.should.length, 2)

        // Name is lucene.keyword + edgeGram, so only the full phrase can match its start
        assert.deepEqual(clauseQueries(phraseGroup), ['בשר טחון', 'בשר טחון', 'בשר טחון'])
        assert.equal(phraseGroup.compound.should[0].autocomplete.path, 'name')
        assert.equal(phraseGroup.compound.should[0].autocomplete.tokenOrder, 'sequential')
        assert.equal(phraseGroup.compound.minimumShouldMatch, 1)

        // The word-level path adds a prefix wildcard on name's standard-analyzed
        // string mapping so a word matches anywhere in the value, not just at the start
        assert.deepEqual(
            wordGroup.compound.must.map(clauseQueries),
            [
                ['בשר*', 'בשר', 'בשר'],
                ['טחון*', 'טחון', 'טחון']
            ]
        )
        const nameWordClause = wordGroup.compound.must[1].compound.should[0].wildcard
        assert.equal(nameWordClause.path, 'name')
        assert.equal(nameWordClause.allowAnalyzedField, true)
    })

    it('finds a word anywhere in a keyword-analyzed name via the string mapping', async () => {
        const { Model, calls } = makeProductModel()
        await searchFactory(Model)('טחון')

        const wordGroup = searchStage(calls).compound.should[1]
        const nameClause = wordGroup.compound.must[0].compound.should[0]

        assert.equal(nameClause.wildcard.query, 'טחון*')
        assert.equal(nameClause.wildcard.path, 'name')
        assert.equal(nameClause.wildcard.allowAnalyzedField, true)
        assert.equal(nameClause.wildcard.score.constant.value, 100)
    })

    it('keeps one must group per word for the word-level path', async () => {
        const { Model, calls } = makeProductModel()
        await searchFactory(Model)('Red Shoes')

        const { compound } = searchStage(calls)
        const wordGroup = compound.should[1]

        assert.equal(wordGroup.compound.must.length, 2)
        for (const group of wordGroup.compound.must)
            assert.equal(group.compound.minimumShouldMatch, 1)
    })

    it('keeps a single-word search as one phrase clause set and one word group', async () => {
        const { Model, calls } = makeProductModel()
        await searchFactory(Model)('milk')

        const { compound } = searchStage(calls)
        assert.equal(compound.should.length, 2)
        assert.deepEqual(clauseQueries(compound.should[0]), ['milk', 'milk', 'milk'])
        assert.deepEqual(compound.should[1].compound.must.map(clauseQueries), [['milk*', 'milk', 'milk']])
    })

    it('splits separators into separate required words', async () => {
        const { Model, calls } = makeProductModel()
        await searchFactory(Model)('red/shoes')

        assert.equal(searchStage(calls).compound.should[1].compound.must.length, 2)
    })

    it('drops one-character words and caps the query at three words', async () => {
        const { Model, calls } = makeProductModel()
        await searchFactory(Model)('a bb cc dd ee')

        const wordGroup = searchStage(calls).compound.should[1]
        assert.deepEqual(wordGroup.compound.must.map(clauseQueries).map(q => q[0]), ['bb*', 'cc*', 'dd*'])
    })

    it('returns nothing for an empty search without querying', async () => {
        const { Model, calls } = makeProductModel()
        const result = await searchFactory(Model)('   ')

        assert.deepEqual(result, [])
        assert.equal(calls.pipe, undefined)
    })

    it('adds a log-scaled, capped sales boost to the score when configured', async () => {
        const { Model, calls } = makeProductModel({
            path: 'totalSalesUnits',
            multiplier: 10,
            cap: 30
        })
        await searchFactory(Model)('milk')

        const boostStage = calls.pipe.find(stage => stage.$addFields?.searchScore?.$add)
        assert.ok(boostStage, 'expected a score boost stage')

        const [base, boost] = boostStage.$addFields.searchScore.$add
        assert.equal(base, '$searchScore')
        assert.equal(boost.$min[0], 30)
        assert.deepEqual(boost.$min[1], {
            $multiply: [
                10,
                { $log10: { $add: [{ $ifNull: ['$totalSalesUnits', 0] }, 1] } }
            ]
        })

        // The boost path is projected before the arithmetic stage so it can be read...
        const intermediate = calls.pipe.find(stage => stage.$project)
        assert.equal(intermediate.$project.totalSalesUnits, 1)

        // ...and the final projection strips it again.
        assert.equal(calls.pipe.at(-1).$project.totalSalesUnits, undefined)
    })

    it('leaves the score unboosted when the model does not configure searchBoost', async () => {
        const { Model, calls } = makeProductModel()
        await searchFactory(Model)('milk')

        assert.equal(calls.pipe.some(stage => stage.$addFields?.searchScore?.$add), false)
    })
})
