import diff from '#common/functions/diff.js'

export default async function update(payload, { DL, _admin }) {
    const { id } = payload

    const product = await DL.Product.readById(id)
    if (!product) throw { status: 400, message: 'product does not exist' }

    const update = diff(product, payload)
    // A name typed by an admin is a human decision, so the nightly Comax and
    // GS1 writers stop replacing it (see Product.nameLocked).
    if (update.name !== undefined) update.nameLocked = true
    const nothingToUpdate = Object.keys(update).length === 0
    if (nothingToUpdate) return product

    const updated = await DL.Product.updateOne({ id }, update)
    return updated
}

update.config = {
    required: ['id'],
    permissions: ['product:update']
}