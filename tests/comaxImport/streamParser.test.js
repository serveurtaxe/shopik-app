import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { splitItemBlocks, parseItemBlock } from '../../server/external/comax/parser.js'

function itemXml(i) {
    return `<ClsItems><ID>${i}</ID><Barcode>${1000 + i}</Barcode><Name>מוצר ${i}</Name><Price>${i + 1}.5</Price>` +
        `<SuperDepartmentCode>${i % 20}</SuperDepartmentCode><SuperDepartment>מחלקה</SuperDepartment>` +
        `<DepartmentCode>3</DepartmentCode><Department>מחלקה</Department>` +
        `<GroupCode>4</GroupCode><Group>קבוצה</Group></ClsItems>`
}

function document(n) {
    const body = Array.from({ length: n }, (_, i) => itemXml(i)).join('\n')
    return `<?xml version="1.0" encoding="utf-8"?>\n<ArrayOfClsItems>\n${body}\n</ArrayOfClsItems>\n`
}

async function* chunks(text, size) {
    for (let i = 0; i < text.length; i += size)
        yield Buffer.from(text.slice(i, i + size), 'utf8')
}

async function collect(source) {
    const out = []
    for await (const block of splitItemBlocks(source)) out.push(block)
    return out
}

describe('comax item block splitter', () => {
    it('splits a catalog into one block per product', async () => {
        const blocks = await collect(chunks(document(5), 4096))

        assert.equal(blocks.length, 5)
        for (const block of blocks) {
            assert.ok(block.startsWith('<ClsItems>'))
            assert.ok(block.endsWith('</ClsItems>'))
        }
        assert.equal(parseItemBlock(blocks[2]).ID, 2)
    })

    it('produces the same blocks no matter where the chunks are cut', async () => {
        const doc = document(7)
        const expected = await collect(chunks(doc, 4096))

        // 1 byte at a time cuts the `<ClsItems>` start tag in half.
        for (const size of [1, 2, 3, 7, 13, 64, 511]) {
            const blocks = await collect(chunks(doc, size))
            assert.deepEqual(blocks, expected, `chunk size ${size}`)
        }
    })

    it('parses the item fields out of a block', async () => {
        const item = parseItemBlock(itemXml(0))

        assert.equal(item.ID, 0)
        assert.equal(item.Barcode, 1000)
        assert.equal(item.Name, 'מוצר 0')
        assert.equal(item.Price, 1.5)
        assert.equal(item.SuperDepartmentCode, 0)
        assert.equal(item.Department, 'מחלקה')
    })

    it('ignores envelope text and self-closing items', async () => {
        const doc = `<?xml version="1.0"?><soap:Envelope><soap:Body><ArrayOfClsItems>` +
            `<ClsItems><ID>1</ID></ClsItems><ClsItems/><ClsItems><ID>2</ID></ClsItems>` +
            `</ArrayOfClsItems></soap:Body></soap:Envelope>`

        const blocks = await collect(chunks(doc, 4096))

        assert.equal(blocks.length, 2)
        assert.equal(parseItemBlock(blocks[0]).ID, 1)
        assert.equal(parseItemBlock(blocks[1]).ID, 2)
    })

    it('yields the first item before the whole document was produced', async () => {
        let produced = 0
        const total = 500
        async function* source() {
            for (let i = 0; i < total; i++) {
                const xml = itemXml(i)
                produced += xml.length
                yield Buffer.from(xml)
            }
        }

        const iterator = splitItemBlocks(source())
        const first = await iterator.next()

        assert.equal(first.done, false)
        assert.ok(first.value.startsWith('<ClsItems>'))
        // A splitter that buffers the whole response would have produced
        // everything before handing out the first item.
        assert.ok(produced < total * 50, `produced ${produced} bytes before the first item`)
    })

    it('parses a block that arrives split across two chunks', async () => {
        const xml = itemXml(1)
        const cut = xml.indexOf('<ID>') + 2

        const blocks = await collect([
            Buffer.from(xml.slice(0, cut)),
            Buffer.from(xml.slice(cut))
        ])

        assert.equal(blocks.length, 1)
        assert.equal(parseItemBlock(blocks[0]).ID, 1)
    })
})
