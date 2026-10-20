import { hideActiveProduct } from './syncRules.js'

export default async function update(payload, { DL }) {
    const { id, active } = payload

    if (typeof id !== 'string' || !id)
        throw { status: 400, message: 'id is required' }
    if (typeof active !== 'boolean')
        throw { status: 400, message: 'active must be a boolean' }

    const comaxProduct = await DL.ComaxProduct.readById(id, { _id: 0, barcode: 1 })
    if (!comaxProduct) throw { status: 400, message: 'comax product does not exist' }

    if (!active && comaxProduct.barcode)
        await hideActiveProduct({ DL, barcode: comaxProduct.barcode })

    return DL.ComaxProduct.updateOne({ id }, { active })
}

update.config = {
    required: ['id', 'active'],
    permissions: ['comax_product:update']
}
