// One log in full, `data` included: the list route ships rows without it (see
// read.js), so the row modal gets the payload snapshot here. Indexed by the
// unique id index, so this is a single indexed lookup instead of a page read.
export default async function id({ id }, { DL }) {
    return DL.Log.readById(id)
}

id.config = {
    log: false,
    required: ['id'],
    permissions: ['log:read']
}
