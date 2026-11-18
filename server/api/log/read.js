// A prod log document averages ~14.9KB, and `data` (the request/response
// snapshot) is nearly all of it: the 30-row Logs page costs ~500KB of read,
// serialize and compress to render seven small columns. Without an explicit
// select this route ships the document without `data`; the row modal opens the
// full document through log/id when an admin actually clicks a row.
const listSelect = { _id: 0, data: 0 }

export default function read(payload, { DL }) {
    const { filter = {}, select } = payload
    return DL.Log.read(filter, select || listSelect, payload)
}

read.config = {
    log: false,
    permissions: ['log:read']
}
