export default async function read(payload, { DL, _admin }) {
    // TODO: _admin.filter
    const { filter = {}, select } = payload
    if (!payload.limit) payload.limit = 0
    return DL.Setting.read(filter, select, payload)
}

read.config = {
    permissions: ['setting:read']
}