// Measures how much heap the streaming splitter keeps alive while walking a
// large catalog. Run with --expose-gc so the numbers are the LIVE set, not
// whatever V8 has not collected yet.
import { splitItemBlocks, parseItemBlock } from '../../../server/external/comax/parser.js'

const COUNT = Number(process.argv[2] || 60000)

function itemXml(i) {
    return `<ClsItems><ID>${i}</ID><Barcode>${1000 + i}</Barcode><Name>מוצר ${i}</Name><Price>${i + 1}.5</Price>` +
        `<SuperDepartmentCode>${i % 20}</SuperDepartmentCode><SuperDepartment>מחלקה</SuperDepartment>` +
        `<DepartmentCode>3</DepartmentCode><Department>מחלקה</Department>` +
        `<GroupCode>4</GroupCode><Group>קבוצה</Group></ClsItems>`
}

function buildDocument(count) {
    const body = Array.from({ length: count }, (_, i) => itemXml(i)).join('\n')
    return `<?xml version="1.0" encoding="utf-8"?>\n<ArrayOfClsItems>\n${body}\n</ArrayOfClsItems>\n`
}

async function* chunks(text, size) {
    for (let i = 0; i < text.length; i += size)
        yield Buffer.from(text.slice(i, i + size), 'utf8')
}

const doc = buildDocument(COUNT)

global.gc()
const baseline = process.memoryUsage().heapUsed

let blocks = 0
for await (const block of splitItemBlocks(chunks(doc, 64 * 1024))) {
    const item = parseItemBlock(block)
    if (item?.ID != null) blocks++
}

global.gc()
const after = process.memoryUsage().heapUsed

console.log(JSON.stringify({
    blocks,
    docBytes: doc.length,
    baseline,
    after,
    growth: after - baseline
}))
