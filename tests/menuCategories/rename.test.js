import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import renameCategory from '#server/api/category/rename.js'
import { buildRenamePlan, normalizeCategoryName } from '#server/services/categoryMap/rename.js'

const tree = () => [
    { id: 'nc:216', code: '216', name: 'פירות וירקות', level: 1, parentId: null, slug: 'פירות-וירקות', path: 'פירות-וירקות' },
    // Takes the slug the renamed category would otherwise get.
    { id: 'nc:300', code: '300', name: 'פירות', level: 1, parentId: null, slug: 'פירות', path: 'פירות' },
    { id: 'nc:203', code: '203', name: 'בשר', level: 1, parentId: null, slug: 'בשר', path: 'בשר' },
    { id: 'nc:216:2016', code: '2016', name: 'פירות טריים', level: 2, parentId: 'nc:216', slug: 'פירות-טריים', path: 'פירות-וירקות/פירות-טריים' },
    { id: 'nc:216:2017', code: '2017', name: 'ירקות', level: 2, parentId: 'nc:216', slug: 'ירקות', path: 'פירות-וירקות/ירקות' },
    { id: 'nc:216:2016:3001', code: '3001', name: 'תפוחים', level: 3, parentId: 'nc:216:2016', slug: 'תפוחים', path: 'פירות-וירקות/פירות-טריים/תפוחים' }
]

const updatesById = plan => new Map(plan.updates.map(update => [update.id, update]))

// A direct product of the renamed category, a leaf under its sub-category (which
// keeps its own title), and a product of a different branch.
const productsFixture = () => [
    { barcode: '1', category: { id: 'nc:216', title: 'פירות וירקות', pathIds: ['nc:216'] } },
    { barcode: '2', category: { id: 'nc:216:2016:3001', title: 'תפוחים', pathIds: ['nc:216', 'nc:216:2016', 'nc:216:2016:3001'] } },
    { barcode: '3', category: { id: 'nc:300', title: 'פירות', pathIds: ['nc:300'] } }
]

describe('category rename plan', () => {
    it('rewrites the path of every category below the renamed one', () => {
        const plan = buildRenamePlan({ categories: tree(), id: 'nc:216', name: 'פירות וירקות ארץ' })
        const byId = updatesById(plan)

        assert.equal(plan.slug, 'פירות-וירקות-ארץ')
        assert.equal(plan.path, 'פירות-וירקות-ארץ')
        assert.deepEqual(byId.get('nc:216'), {
            id: 'nc:216',
            name: 'פירות וירקות ארץ',
            slug: 'פירות-וירקות-ארץ',
            path: 'פירות-וירקות-ארץ'
        })
        assert.deepEqual(byId.get('nc:216:2016'), { id: 'nc:216:2016', path: 'פירות-וירקות-ארץ/פירות-טריים' })
        assert.deepEqual(byId.get('nc:216:2016:3001'), { id: 'nc:216:2016:3001', path: 'פירות-וירקות-ארץ/פירות-טריים/תפוחים' })
        assert.equal(byId.get('nc:216:2017').path, 'פירות-וירקות-ארץ/ירקות')

        // Other branches keep their stored paths: the renamed category plus the
        // two children and the grandchild.
        assert.equal(byId.size, 4)
        assert.ok(!byId.has('nc:300') && !byId.has('nc:203'))
    })

    it('resolves a slug clash with a sibling the way the CSV importer does', () => {
        const plan = buildRenamePlan({ categories: tree(), id: 'nc:216', name: 'פירות' })

        assert.equal(plan.slug, 'פירות-216')
        assert.equal(updatesById(plan).get('nc:216:2016').path, 'פירות-216/פירות-טריים')
    })

    it('renames a leaf without touching anything else', () => {
        const plan = buildRenamePlan({ categories: tree(), id: 'nc:216:2016:3001', name: 'תפוחי נוער' })

        assert.equal(plan.path, 'פירות-וירקות/פירות-טריים/תפוחי-נוער')
        assert.equal(plan.updates.length, 1)
    })

    it('keeps the parent prefix when renaming a middle category', () => {
        const plan = buildRenamePlan({ categories: tree(), id: 'nc:216:2016', name: 'תפוחים' })
        const byId = updatesById(plan)

        assert.equal(plan.path, 'פירות-וירקות/תפוחים')
        assert.equal(byId.get('nc:216:2016:3001').path, 'פירות-וירקות/תפוחים/תפוחים')
        assert.ok(!byId.has('nc:216'), 'the parent is not rewritten')
        assert.ok(!byId.has('nc:216:2017'), 'its sibling is not rewritten')
    })

    it('writes the name even when the slug and paths stay the same', () => {
        const plan = buildRenamePlan({ categories: tree(), id: 'nc:203', name: 'בשר!' })
        const update = plan.updates[0]

        // toSlug('בשר!') === 'בשר', so only the name changes.
        assert.equal(plan.slug, 'בשר')
        assert.equal(plan.updates.length, 1)
        assert.deepEqual(update, { id: 'nc:203', name: 'בשר!', slug: 'בשר', path: 'בשר' })
    })

    it('reports nothing to write for the same name', () => {
        assert.deepEqual(buildRenamePlan({ categories: tree(), id: 'nc:203', name: 'בשר' }).updates, [])
    })

    it('returns null for an unknown id', () => {
        assert.equal(buildRenamePlan({ categories: tree(), id: 'nc:404', name: 'בשר' }), null)
    })

    it('validates the name like the category schema', () => {
        assert.equal(normalizeCategoryName('  בשר  '), 'בשר')
        for (const bad of ['', '  ', 'ב', undefined, null, 'ב'.repeat(101)])
            assert.throws(() => normalizeCategoryName(bad), { status: 400 })
    })
})

function fakeDL(categories = tree(), products = productsFixture()) {
    const categoryWrites = []
    const productWrites = []
    const cached = []

    const DL = {
        Category: {
            read: async () => categories,
            cache: { add: async docs => cached.push(docs) },
            Model: {
                bulkWrite: async ops => categoryWrites.push(...ops),
                find: filter => ({
                    lean: async () => categories.filter(category => filter.id.$in.includes(category.id))
                })
            }
        },
        Product: {
            Model: {
                updateMany: async (filter, update) => {
                    productWrites.push({ filter, update })
                    // What MongoDB would match with this filter: category.pathIds is
                    // the indexed selector (the category and everything below it),
                    // category.id narrows it back to the category itself.
                    const matched = products.filter(product =>
                        (product.category.pathIds || []).includes(filter['category.pathIds']) &&
                        product.category.id === filter['category.id'])
                    matched.forEach(product => { product.category.title = update.$set['category.title'] })
                    return { modifiedCount: matched.length }
                }
            }
        }
    }

    return { DL, categoryWrites, productWrites, cached, products }
}

describe('category rename endpoint', () => {
    it('writes the new slug/path plus the paths below it', async () => {
        const { DL, categoryWrites } = fakeDL()
        const res = await renameCategory({ id: 'nc:216', name: 'פירות וירקות ארץ' }, { DL })

        assert.equal(res.categories, 4)
        assert.equal(res.path, 'פירות-וירקות-ארץ')

        const sets = new Map(categoryWrites.map(op => [op.updateOne.filter.id, op.updateOne.update.$set]))
        assert.deepEqual(sets.get('nc:216'), {
            name: 'פירות וירקות ארץ',
            slug: 'פירות-וירקות-ארץ',
            path: 'פירות-וירקות-ארץ'
        })
        // Descendants only get a path: their names and slugs are their own.
        assert.deepEqual(sets.get('nc:216:2016:3001'), { path: 'פירות-וירקות-ארץ/פירות-טריים/תפוחים' })
    })

    it('syncs the DL cache the raw bulkWrite bypassed', async () => {
        const { DL, cached } = fakeDL()
        await renameCategory({ id: 'nc:216', name: 'פירות וירקות ארץ' }, { DL })

        assert.equal(cached.length, 1)
        assert.equal(cached[0].length, 4)
        assert.ok(cached[0].every(category => !('_id' in category)))
    })

    it('refreshes the title products denormalized, and only for this category', async () => {
        const { DL, productWrites, products } = fakeDL()
        const res = await renameCategory({ id: 'nc:216', name: 'פירות וירקות ארץ' }, { DL })

        assert.equal(res.products, 1)
        assert.deepEqual(productWrites, [{
            // pathIds carries the update on an index products actually has; category.id
            // is what "mapped to this category" means, and it stays in the filter so the
            // sub-category products are not swept in with it.
            filter: { 'category.pathIds': 'nc:216', 'category.id': 'nc:216' },
            update: { $set: { 'category.title': 'פירות וירקות ארץ' } }
        }])

        assert.equal(products.find(p => p.barcode === '1').category.title, 'פירות וירקות ארץ')
        assert.equal(products.find(p => p.barcode === '2').category.title, 'תפוחים', 'a leaf keeps its own title')
        assert.equal(products.find(p => p.barcode === '3').category.title, 'פירות', 'another branch is untouched')
    })

    it('skips every write when nothing changes', async () => {
        const { DL, categoryWrites, productWrites, cached } = fakeDL()
        const res = await renameCategory({ id: 'nc:203', name: 'בשר' }, { DL })

        assert.deepEqual(res, {
            ok: true,
            id: 'nc:203',
            name: 'בשר',
            slug: 'בשר',
            path: 'בשר',
            categories: 0,
            products: 0
        })
        assert.equal(categoryWrites.length, 0)
        assert.equal(productWrites.length, 0)
        assert.equal(cached.length, 0)
    })

    it('rejects a missing or unknown category and a bad name', async () => {
        const cases = [
            [{ name: 'בשר' }, 400, 'id required'],
            [{ id: 'nc:404', name: 'בשר' }, 404, 'not found'],
            [{ id: 'nc:203', name: 'ב' }, 400, 'at least 2'],
            [{ id: 'nc:203', name: '   ' }, 400, 'at least 2'],
            [{ id: 'nc:203', name: 'ב'.repeat(101) }, 400, 'at most 100']
        ]

        for (const [payload, status, text] of cases) {
            const { DL } = fakeDL()
            let error = null
            try {
                await renameCategory(payload, { DL })
            } catch (e) {
                error = e
            }

            assert.ok(error, `expected a rejection for ${JSON.stringify(payload)}`)
            assert.equal(error.status, status)
            assert.ok(String(error.message).includes(text), error.message)
        }
    })

    it('needs category:update', () => {
        assert.deepEqual(renameCategory.config, {
            required: ['id', 'name'],
            permissions: ['category:update']
        })
    })
})
