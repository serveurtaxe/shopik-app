import diff from '#common/functions/diff.js'

export default async function update(payload, { DL, _admin }) {
    const { id } = payload

    const setting = await DL.Setting.readById(id)
    if (!setting)
        throw { status: 400, message: 'setting does not exist' }

    const update = diff(setting, payload)
    // Pixel size is captured by setting/upload_file. A manual value edit has
    // no size, so clear the stale one rather than emit wrong og:image hints.
    if (update.value !== undefined) {
        update.width = null
        update.height = null
    }
    if (update.domainId) {
        const domain = await DL.Domain.readById(update.domainId)
        if (!domain)
            throw { status: 400, message: 'invalid domain id' }
    }
    const nothingToUpdate = Object.keys(update).length === 0
    if (nothingToUpdate)
        return setting

    const updated = await DL.Setting.updateOne({ id }, update)
    if (!updated)
        throw { status: 404, message: 'setting could not be updated — the row is not in the database (the settings cache is stale, reset it)' }
    return updated
}

update.config = {
    required: ['id'],
    permissions: ['setting:update']
}