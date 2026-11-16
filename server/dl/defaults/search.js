const searchFieldRegex = /[^\d\sA-Za-zא-ת%.]/g
const separatorRegex = /[-,/\\]/g

const isPrefixField = (Model, path) =>
    !!Model.searchPrefixFields && Object.prototype.hasOwnProperty.call(Model.searchPrefixFields, path)

/**
 * Builds the compound.should clauses for a single word against fields that
 * have a word-level analyzer (standard).
 *
 * Keyword-analyzed prefix fields are skipped: a lone word can only match the
 * very start of the whole value there, so they are handled by
 * buildPhraseClauses with the full query instead.
 *
 * @param {Object} Model - The Mongoose/Model instance containing searchFields config.
 * @param {string} term - A single sanitized word (e.g., "red").
 * @returns {Object[]} Clauses for compound.should.
 */
function buildWordClauses(Model, term) {
    // Schema-driven tiered ranking:
    // - search: autocomplete boost (e.g. name:30, label:8)
    // - searchPrefixBoost: sequential prefix boost on dual-type field (edgeGram keyword) (e.g. name:100, label:15)
    // - searchFuzzy: typo-tolerant autocomplete (e.g. name:3, label:1)
    // Product schema now defines all tiers explicitly; other models fallback to generic.
    const shouldClauses = []

    // Prefix fields are keyword-analyzed for the starts-with phrase tier, but
    // ensureSearchIndex also maps them as `string` (standard analyzer). A prefix
    // wildcard there lets a word match anywhere in the value, e.g. "טחון" in
    // "בשר טחון", without rebuilding the index. The phrase tier above still adds
    // its own bonus on top when the value starts with the query.
    for (const [path, score] of Object.entries(Model.searchPrefixFields || {})) {
        shouldClauses.push({
            wildcard: {
                query: `${term}*`,
                path,
                allowAnalyzedField: true,
                score: { constant: { value: score } }
            }
        })
    }

    // Regular autocomplete per word-analyzed search field — generic models double-weight autocomplete vs fuzzy (boost*2 / boost)
    const hasPrefixForWeight = Model.searchPrefixFields && Object.keys(Model.searchPrefixFields).length > 0
    for (const [path, score] of Object.entries(Model.searchFields || {})) {
        if (isPrefixField(Model, path)) continue
        const autocompleteScore = hasPrefixForWeight ? score : score * 2
        shouldClauses.push({
            autocomplete: {
                query: term,
                path,
                score: { constant: { value: autocompleteScore } }
            }
        })
    }

    // Fuzzy — explicit per-field if defined (product: name:3, label:1), otherwise generic fallback for other models
    if (Model.searchFuzzyFields && Object.keys(Model.searchFuzzyFields).length) {
        for (const [path, score] of Object.entries(Model.searchFuzzyFields)) {
            if (isPrefixField(Model, path)) continue
            shouldClauses.push({
                autocomplete: {
                    query: term,
                    path,
                    fuzzy: { maxEdits: 1, prefixLength: 2 },
                    score: { constant: { value: score } }
                }
            })
        }
    } else if (Model.searchFields) {
        // Generic fuzzy for non-product models that don't define searchFuzzy
        const hasFuzzy = Model.searchFuzzyFields && Object.keys(Model.searchFuzzyFields).length > 0
        const hasPrefix = Model.searchPrefixFields && Object.keys(Model.searchPrefixFields).length > 0
        if (!hasFuzzy && !hasPrefix) {
            for (const [path, score] of Object.entries(Model.searchFields)) {
                shouldClauses.push({
                    autocomplete: {
                        query: term,
                        path,
                        fuzzy: { maxEdits: 1, prefixLength: 2 },
                        score: { constant: { value: score } }
                    }
                })
            }
        }
    }

    return shouldClauses
}

/**
 * Builds clauses that match the whole query as a starts-with phrase on
 * keyword-analyzed prefix fields. Because those fields are indexed as a
 * single term, only the full phrase can use them: "בשר טחון" matches names
 * that start with "בשר טחון", and implies every word is present.
 *
 * @param {Object} Model - The Mongoose/Model instance containing searchPrefixFields config.
 * @param {string} phrase - The joined query (e.g., "בשר טחון").
 * @returns {Object[]} Clauses for compound.should.
 */
function buildPhraseClauses(Model, phrase) {
    const shouldClauses = []

    // Prefix boosts (sequential = field starts with phrase) — highest tier
    for (const [path, score] of Object.entries(Model.searchPrefixFields || {})) {
        shouldClauses.push({
            autocomplete: {
                query: phrase,
                path,
                tokenOrder: 'sequential',
                score: { constant: { value: score } }
            }
        })
    }

    // Regular autocomplete on the same keyword-analyzed fields (phrase, not word-level)
    const hasPrefixForWeight = Model.searchPrefixFields && Object.keys(Model.searchPrefixFields).length > 0
    for (const [path, score] of Object.entries(Model.searchFields || {})) {
        if (!isPrefixField(Model, path)) continue
        shouldClauses.push({
            autocomplete: {
                query: phrase,
                path,
                score: { constant: { value: hasPrefixForWeight ? score : score * 2 } }
            }
        })
    }

    // Phrase-level fuzzy on keyword-analyzed fields
    if (Model.searchFuzzyFields && Object.keys(Model.searchFuzzyFields).length) {
        for (const [path, score] of Object.entries(Model.searchFuzzyFields)) {
            if (!isPrefixField(Model, path)) continue
            shouldClauses.push({
                autocomplete: {
                    query: phrase,
                    path,
                    fuzzy: { maxEdits: 1, prefixLength: 2 },
                    score: { constant: { value: score } }
                }
            })
        }
    }

    return shouldClauses
}

/**
 * Generates a MongoDB Atlas Search query object based on the Model's configuration.
 * A document matches when either:
 * - its keyword-analyzed prefix field starts with the full phrase (e.g. the
 *   product name starts with "בשר טחון"), or
 * - every word matches at least one word-analyzed field (AND across words,
 *   OR across fields per word).
 * 
 * @param {Object} Model - The Mongoose/Model instance containing collection info and searchFields config.
 * @param {string[]} words - The sanitized search words (e.g., ["בשר", "טחון"]).
 * @returns {Object} The $search object ready to be used in a query pipeline.
 */
function buildSearchQuery(Model, words) {
    const indexName = Model.getSearchIndexName()
    const terms = Array.isArray(words) ? words : [words]

    const alternatives = []

    // Starts-with phrase path — also gives name-prefix matches their high score
    const phraseClauses = buildPhraseClauses(Model, terms.join(' '))
    if (phraseClauses.length) {
        alternatives.push({
            compound: {
                should: phraseClauses,
                minimumShouldMatch: 1
            }
        })
    }

    // All-words path — each word may hit a different field, but every word must hit one
    const wordClauseGroups = terms.map(term => buildWordClauses(Model, term))
    if (wordClauseGroups.every(clauses => clauses.length)) {
        alternatives.push({
            compound: {
                must: wordClauseGroups.map(clauses => ({
                    compound: {
                        should: clauses,
                        minimumShouldMatch: 1
                    }
                }))
            }
        })
    }

    return {
        $search: {
            index: indexName,
            compound: {
                should: alternatives,
                minimumShouldMatch: 1
            }
        }
    }
}

/**
 * Builds an additive popularity boost for search relevance, or null when the
 * model opts out.
 *
 * The boost is `multiplier * log10(1 + value)` capped at `cap`, so points grow
 * quickly for the first sales and flatten out. Because relevance tiers are
 * constant scores (name prefix 100, autocomplete 30, category 5, ...), this
 * nudges best sellers up without letting popularity beat a strong text match.
 *
 * @param {Object} boost - e.g. { path: 'totalSalesUnits', multiplier: 10, cap: 30 }.
 * @returns {Object|null} Aggregation expression, or null when disabled.
 */
function buildBoostExpression(boost) {
    if (!boost?.path || !boost.multiplier) return null

    const expression = {
        $multiply: [
            boost.multiplier,
            { $log10: { $add: [{ $ifNull: [`$${boost.path}`, 0] }, 1] } }
        ]
    }

    return boost.cap != null
        ? { $min: [boost.cap, expression] }
        : expression
}

export default (Model) => async function search(value = '', filter, options = {}) {
    if (!value || typeof value !== 'string') return []
    if (!Model.searchFields)
        throw { status: 400, message: 'model does not support search' }

    const { skip = 0, limit = 50, select } = options

    const sanitizedWords = value
        .toLowerCase()
        .replace(separatorRegex, ' ')
        .replace(searchFieldRegex, '')
        .replace(/\s+/g, ' ')
        .split(/\s+/)
        .map(v => v
            .replace(/(^| )\D+\d*%($| )/g, '')
            .replace(/(^| )%\d*\D+($| )/g, '')
            .replace(/(\D+)%/g, '$1')
            .replace(/%(\D+)/g, '$1')
            .replace(/%(\d+)/g, '$1%')
        )
        .filter(v => v.length > 1)
        .slice(0, 3)

    if (!sanitizedWords.length) return []

    const searchStage = buildSearchQuery(Model, sanitizedWords)

    const projection = select || Model.defaultSelect
    const sort = Model.defaultSort || {}
    const boostExpression = buildBoostExpression(Model.searchBoost)
    const pipe = [
        searchStage,
        ...(filter ? [{ $match: filter }] : []),
        ...(projection ?
            [{
                $project: {
                    _id: 0,
                    ...projection,
                    ...sort,
                    // The boost path must survive this stage to be read below;
                    // the final $project strips it again.
                    ...(boostExpression ? { [Model.searchBoost.path]: 1 } : {}),
                    searchScore: { $meta: 'score' }
                }
            }] :
            [{
                $addFields: {
                    searchScore: { $meta: 'score' }
                }
            }]
        ),
        ...(boostExpression ?
            [{
                $addFields: {
                    searchScore: { $add: ['$searchScore', boostExpression] }
                }
            }] :
            []
        ),
        { $sort: { searchScore: -1, ...sort } },
        { $skip: Number(skip) },
        { $limit: Number(limit) }
    ]
    if (projection) {
        pipe.push({ $project: projection })
    }

    return Model.aggregate(pipe)
}