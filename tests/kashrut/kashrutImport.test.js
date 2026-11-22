import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeRabbinates } from '../../common/components/Kashrut/constants.js'
import { mapKashrut } from '../../server/external/gs1/mapper.js'
import loadKashrut, {
    parseCsvRows,
    parseKashrutCsv,
    planKashrutUpdate
} from '../../server/api/product/load_kashrut.js'

const code = (n, name) => ({ code: String(n), name })
// Canonical names come from KASHRUT_RABBINATES (common/components/Kashrut/constants.js).
const CANON_67085 = 'בד"ץ העדה החרדית ירושלים'
const CANON_55004 = 'הרב ביסטריצקי'

// Mirrors the real export: Hebrew headers, a quoted supplier name carrying an
// escaped gershayim, an empty כשרות column, and a trailing blank line.
const CSV = [
    'ברקוד,שם מוצר,שם ספק,כשרות לטעינה,קוד כשרות,כשרות,האם ב GS1',
    '1003848,כבד טרי ביסטרצקי,"עוף ירושלים שיווק בע""מ",הרב ביסטריצקי,55004,,לא',
    '1014,אבוקדו,"דודו עזרא בע""מ",בדצ העדה החרדית,67085,,לא',
    '7290014761698,עמק סמי 600 גר\' בדץ עדח,תנובה חלב,בדצ העדה החרדית,67085,חלבי,כן',
    ''
].join('\r\n')

describe('parseCsvRows', () => {
    it('reads quoted fields containing commas and escaped quotes', () => {
        const rows = parseCsvRows('a,"x, y","he said ""hi""",b')
        assert.deepEqual(rows[0], ['a', 'x, y', 'he said "hi"', 'b'])
    })

    it('handles LF, CRLF and a leading BOM', () => {
        assert.deepEqual(parseCsvRows('\uFEFFa,b\nc,d\r\n'), [['a', 'b'], ['c', 'd']])
    })

    it('keeps the trailing line without a line break', () => {
        assert.deepEqual(parseCsvRows('a,b\nc,d'), [['a', 'b'], ['c', 'd']])
    })
})

describe('parseKashrutCsv', () => {
    it('maps by header name and ignores the informational columns', () => {
        const rows = parseKashrutCsv(CSV)
        assert.equal(rows.length, 3)
        assert.deepEqual(rows[0], { barcode: '1003848', code: '55004', name: 'כבד טרי ביסטרצקי' })
        assert.equal(rows[2].barcode, '7290014761698')
    })

    it('drops the blank line the export ends with', () => {
        assert.equal(parseKashrutCsv(CSV).some(r => !r.barcode), false)
    })

    it('tolerates header spelling that differs only by spaces and gershayim', () => {
        const rows = parseKashrutCsv('ברקוד , שם מוצר , "קוד""כשרות"\n1,גלידה,67085')
        assert.deepEqual(rows, [{ barcode: '1', code: '67085', name: 'גלידה' }])
    })

    it('rejects a file without the barcode/code columns', () => {
        assert.throws(() => parseKashrutCsv('שם מוצר,שם ספק\nאבוקדו,דודו'), e => e.status === 400)
    })
})

describe('mergeRabbinates', () => {
    it('adds only missing codes and keeps the stored order and names', () => {
        const merged = mergeRabbinates([code(67093, 'בדצ בית יוסף'), code(67085, 'בדצ העדה החרדית')], [code(67085), code(55004)])
        assert.deepEqual(merged, [
            code(67093, 'בדצ בית יוסף'),
            code(67085, 'בדצ העדה החרדית'),
            { code: '55004', name: 'הרב ביסטריצקי' }
        ])
    })

    it('dedupes the additions themselves and fills a missing name from the table', () => {
        const merged = mergeRabbinates([], [code(67085, ''), code(67085, 'duplicate'), code(67085)])
        assert.deepEqual(merged, [code('67085', CANON_67085)])
    })

    it('keeps name-only entries (GS1 sends a name without a code)', () => {
        const merged = mergeRabbinates([{ name: 'רבנות אחרת' }], [{ name: 'רבנות אחרת' }, { name: 'רבנות אחרת' }])
        assert.deepEqual(merged, [{ name: 'רבנות אחרת' }])
    })

    it('accepts a missing side', () => {
        assert.deepEqual(mergeRabbinates(undefined, [code(67085)]), [{ code: '67085', name: CANON_67085 }])
        assert.deepEqual(mergeRabbinates([code(67085, 'x')], null), [code('67085', 'x')])
        assert.deepEqual(mergeRabbinates([], []), [])
    })
})

describe('planKashrutUpdate', () => {
    it('reports unchanged when the code is already stored', () => {
        const plan = planKashrutUpdate({ rabbinates: [code(67085, 'בדצ העדה החרדית')], supervisionType: '182' }, ['67085'])
        assert.equal(plan.changed, false)
        assert.equal(plan.kashrut.supervisionType, '182')
    })

    it('appends the new code without dropping the stored one', () => {
        const plan = planKashrutUpdate({ rabbinates: [code(67093, 'בדצ בית יוסף')], supervisionType: '182' }, ['67085'])
        assert.equal(plan.changed, true)
        assert.deepEqual(plan.kashrut.rabbinates.map(r => r.code), ['67093', '67085'])
        assert.equal(plan.kashrut.supervisionType, '182')
    })

    it('rewrites the ignored legacy string into the object shape', () => {
        const plan = planKashrutUpdate('חלבי / בד"ץ העדה החרדית', ['67085'])
        assert.equal(plan.legacy, true)
        assert.equal(plan.changed, true)
        assert.deepEqual(plan.kashrut, { rabbinates: [code('67085', CANON_67085)] })
    })

    it('creates kashrut for a product that has none', () => {
        const plan = planKashrutUpdate(undefined, ['55004'])
        assert.equal(plan.changed, true)
        assert.deepEqual(plan.kashrut.rabbinates, [{ code: '55004', name: 'הרב ביסטריצקי' }])
    })
})

// Fake DL: read returns the products whose barcode (or scan alias) is in the
// $in filter, in either the plain `barcode` or the `$or` shape.
function fakeDL(products = []) {
    const writes = []
    return {
        writes,
        Product: {
            read: async (filter = {}) => {
                const clauses = filter.$or || [filter]
                const byBarcode = clauses.flatMap(clause => clause.barcode?.$in || [])
                const byAlias = clauses.flatMap(clause => clause.scannableBarcodes?.$in || [])
                return products.filter(p =>
                    byBarcode.includes(p.barcode)
                    || (p.scannableBarcodes || []).some(alias => byAlias.includes(String(alias))))
            },
            bulkWrite: async ({ docs, getUpdate }) => {
                writes.push(...docs.map(d => ({ barcode: d.barcode, update: getUpdate(d) })))
                return { modifiedCount: docs.length }
            }
        }
    }
}

const info = DL => ({ DL })

describe('load_kashrut', () => {
    it('dry run (the default) reports without writing', async () => {
        const DL = fakeDL([{ barcode: '1003848', kashrut: { rabbinates: [code(67093, 'בדצ בית יוסף')] } }])
        const report = await loadKashrut({ csv: CSV }, info(DL))
        assert.equal(report.dryRun, true)
        assert.equal(report.rows, 3)
        assert.equal(report.barcodes, 3)
        assert.equal(report.matched, 1)
        assert.equal(report.updated, 1)
        assert.equal(report.unchanged, 0)
        assert.deepEqual(report.unmatched, [
            { barcode: '1014', name: 'אבוקדו' },
            { barcode: '7290014761698', name: 'עמק סמי 600 גר\' בדץ עדח' }
        ])
        assert.equal(DL.writes.length, 0)
    })

    it('counts a product that already carries the code as unchanged', async () => {
        const DL = fakeDL([{ barcode: '1014', kashrut: { rabbinates: [code(67085, 'בדצ העדה החרדית')] } }])
        const report = await loadKashrut({ csv: CSV }, info(DL))
        assert.equal(report.matched, 1)
        assert.equal(report.unchanged, 1)
        assert.equal(report.updated, 0)
        assert.equal(report.unmatched.length, 2)
    })

    it('writes the merged kashrut when dryRun is false', async () => {
        const DL = fakeDL([
            { barcode: '1003848', kashrut: { rabbinates: [code(67093, 'בדצ בית יוסף')], supervisionType: '181' } },
            { barcode: '1014' }
        ])
        const report = await loadKashrut({ csv: CSV, dryRun: false }, info(DL))
        assert.equal(report.dryRun, false)
        assert.equal(report.updated, 2)
        assert.equal(report.unmatched.length, 1)
        assert.equal(DL.writes.length, 2)
        const write = DL.writes.find(w => w.barcode === '1003848')
        assert.deepEqual(Object.keys(write.update), ['$set'])
        assert.deepEqual(write.update.$set.kashrut.rabbinates.map(r => r.code), ['67093', '55004'])
        assert.equal(write.update.$set.kashrut.supervisionType, '181')
    })

    it('matches a row whose barcode is a scan alias and writes it to the owner', async () => {
        const DL = fakeDL([
            { barcode: '1003848', scannableBarcodes: ['7290014761698'] }
        ])

        const report = await loadKashrut({ csv: CSV, dryRun: false }, info(DL))

        // The alias row and the main row both land on the owning product; the
        // product that is not in the catalog stays unmatched.
        assert.deepEqual(report.unmatched.map(row => row.barcode), ['1014'])
        assert.ok(DL.writes.every(write => write.barcode === '1003848'))
    })

    it('reports codes that are not in the priority table instead of writing them', async () => {
        const DL = fakeDL([{ barcode: '1014' }])
        const report = await loadKashrut({ csv: 'ברקוד,קוד כשרות\n1003848,99999\n1014,67085', dryRun: false }, info(DL))
        assert.deepEqual(report.invalid, [{ barcode: '1003848', code: '99999', name: '' }])
        assert.equal(report.barcodes, 1)
        assert.equal(report.matched, 1)
        assert.deepEqual(DL.writes[0], {
            barcode: '1014',
            update: { $set: { kashrut: { rabbinates: [{ code: '67085', name: CANON_67085 }] } } }
        })
    })

    it('rejects an empty csv and a headerless one', async () => {
        const DL = fakeDL([])
        await assert.rejects(() => loadKashrut({ csv: '' }, info(DL)), e => e.status === 400)
        await assert.rejects(() => loadKashrut({ csv: 'ברקוד,שם מוצר\n1,אבוקדו' }, info(DL)), e => e.status === 400)
    })

    it('needs the csv field', async () => {
        assert.deepEqual(loadKashrut.config.required, ['csv'])
        assert.deepEqual(loadKashrut.config.permissions, ['product:update'])
    })
})

describe('GS1 enrich merge', () => {
    // server/services/gs1/enrich.js applies exactly this call before buffering the
    // $set, so the nightly run cannot drop a rabbinate loaded by hand.
    it('keeps a manually loaded rabbinate when GS1 writes its own', () => {
        const manual = [code(55004, CANON_55004)]
        const { kashrut } = mapKashrut({
            Rabbinate: [{ value: 'בדצ העדה החרדית', code: '67085' }],
            Kosher_Supervision_Type: [{ code: '181' }]
        })
        const merged = mergeRabbinates(manual, kashrut.rabbinates)
        assert.deepEqual(merged.map(r => r.code), ['55004', '67085'])
        assert.equal(merged[0].name, CANON_55004)
        assert.equal(merged[1].name, 'בדצ העדה החרדית')
    })

    it('is stable across repeated runs', () => {
        const once = mergeRabbinates([], [code(67085, 'בדצ העדה החרדית')])
        const twice = mergeRabbinates(once, [code(67085, 'בדצ העדה החרדית')])
        assert.deepEqual(twice, once)
    })
})
