import loadDir from '#common/functions/loadDir.js'
import createModels from './createModels.js'
import connect from './connect.js'
import { encryptValue, decryptDocs, decryptDoc, isEncrypted } from '#server/utils/settingsEncryption.js'

export default async function createDL(__dirname) {
    const { redis } = await connect()
    const
        [defaults, models] = await Promise.all([
            loadDir(__dirname, './dl/defaults'),
            createModels(redis)
        ]),
        DL = { redis }

    for (let entry of Object.entries(models)) {
        const [modelName, Model] = entry
        DL[modelName] = {
            Model,
            // Exposed so `DL.X.cache.del/add` works next to direct Model writes.
            // Without it the optional-chained call is a silent no-op and the
            // hashset keeps docs (or field values) that Mongo no longer has.
            cache: Model.cache,
            constants: Model.constants,
            defaultSelect: Model.defaultSelect,
            defaultSelectOne: Model.defaultSelectOne
        }
        if (Model.methods) {
            for (const [name, func] of Object.entries(Model.methods)) {
                DL[modelName][name] = func
            }
            delete Model.methods
        }
        for (let [name, factory] of Object.entries(defaults)) {
            const func = factory(Model)
            DL[modelName][name] = func
        }
    }

    // Encrypt/decrypt config-type Settings values at rest
    if (DL.Setting) {
        const SettingModel = DL.Setting.Model

        function shouldEncryptForWrite(docOrUpdate) {
            if (!docOrUpdate) return false
            return docOrUpdate.formType === 'config' || docOrUpdate.renderType === 'config'
        }

        // Wrap create
        const origCreate = DL.Setting.create
        DL.Setting.create = async (data) => {
            const encryptOne = (d) => {
                if (shouldEncryptForWrite(d) && d.value !== undefined && !isEncrypted(d.value)) {
                    d.value = encryptValue(d.value)
                }
                return d
            }
            if (Array.isArray(data)) data.forEach(encryptOne)
            else encryptOne(data)
            const res = await origCreate(data)
            // decrypt for caller (plain display) — DB/cache remain encrypted
            if (Array.isArray(res)) {
                const plain = res.map(r => r?.toObject ? r.toObject() : r)
                return decryptDocs(plain)
            }
            if (res?.toObject) {
                const obj = res.toObject()
                return decryptDoc(obj)
            }
            return decryptDoc(res)
        }

        // Wrap read (many)
        const origRead = DL.Setting.read
        DL.Setting.read = async (...args) => {
            const docs = await origRead(...args)
            return decryptDocs(docs)
        }

        const origReadOne = DL.Setting.readOne
        DL.Setting.readOne = async (...args) => {
            const doc = await origReadOne(...args)
            return decryptDoc(doc)
        }

        const origReadById = DL.Setting.readById
        DL.Setting.readById = async (...args) => {
            const doc = await origReadById(...args)
            return decryptDoc(doc)
        }

        // Wrap updateOne
        const origUpdateOne = DL.Setting.updateOne
        DL.Setting.updateOne = async (filter, update, options) => {
            if (update) {
                const val = update.value ?? update.$set?.value
                if (val !== undefined) {
                    const formType = update.formType ?? update.$set?.formType
                    const renderType = update.renderType ?? update.$set?.renderType
                    let shouldEncrypt = formType === 'config' || renderType === 'config'
                    if (!shouldEncrypt && formType === undefined && renderType === undefined) {
                        try {
                            const existing = await SettingModel.findOne(filter, { formType: 1, renderType: 1, _id: 0 }).lean()
                            shouldEncrypt = existing?.formType === 'config' || existing?.renderType === 'config'
                        } catch {}
                    }
                    if (shouldEncrypt && !isEncrypted(val)) {
                        const enc = encryptValue(val)
                        if (update.$set) update.$set.value = enc
                        else update.value = enc
                    }
                }
            }
            const res = await origUpdateOne(filter, update, options)
            return decryptDocs(res)
        }

        // Wrap update (bulk)
        const origUpdate = DL.Setting.update
        DL.Setting.update = async (filter, update, options) => {
            if (update) {
                const val = update.value ?? update.$set?.value
                if (val !== undefined) {
                    const formType = update.formType ?? update.$set?.formType
                    const renderType = update.renderType ?? update.$set?.renderType
                    if ((formType === 'config' || renderType === 'config') && !isEncrypted(val)) {
                        const enc = encryptValue(val)
                        if (update.$set) update.$set.value = enc
                        else update.value = enc
                    }
                }
            }
            const res = await origUpdate(filter, update, options)
            if (Array.isArray(res)) return decryptDocs(res)
            return res
        }

        // Wrap bulkWrite if used for settings
        if (DL.Setting.bulkWrite) {
            const origBulk = DL.Setting.bulkWrite
            DL.Setting.bulkWrite = async (args) => {
                if (args?.docs) {
                    for (const d of args.docs) {
                        if (shouldEncryptForWrite(d) && d.value !== undefined && !isEncrypted(d.value)) {
                            d.value = encryptValue(d.value)
                        }
                    }
                }
                const res = await origBulk(args)
                return res
            }
        }
    }

    DL.populate = async function populate(docs, docField, sourceMap) {
        if (!docs?.length) return docs
        if (!sourceMap || !Object.keys(sourceMap).length) return docs
        if (!docField.endsWith('Id')) return docs

        const [model] = docField.split('Id')
        if (!model) return docs

        const modelName = `${model[0].toUpperCase()}${model.slice(1)}`
        const Model = DL[modelName]?.Model
        if (!Model) return docs

        const sourceIds = docs.map(doc => doc[docField]).filter(Boolean)
        if (sourceIds.length === 0) return docs

        const sourceKeys = Object.keys(sourceMap)
        const sourceEntries = Object.entries(sourceMap)
        const select = Object.fromEntries(sourceKeys.map(key => [key, 1]))
        select.id = 1

        // Cache miss (no cache, Redis down, or an empty hash) → read from Mongo.
        let sources = await Model.cache?.get(sourceIds, select)
        if (!sources?.length) {
            sources = await DL[modelName].read({ id: sourceIds }, { ...select, _id: 0 })
        }
        if (sources?.length) {
            const sourceHash = sources.reduce((acc, source) => ({ ...acc, [source.id]: source }), {})

            return docs.map(doc => ({
                ...doc,
                ...Object.fromEntries(
                    sourceEntries.map(([sourceKey, docKey]) => {
                        let transformer,
                            key = docKey
                        if (typeof docKey === 'object') {
                            key = docKey.key
                            transformer = docKey.format
                        }
                        const id = doc[docField]
                        const sourceValue = sourceHash[id]?.[sourceKey]
                        if (sourceValue === undefined) return null

                        const value = transformer?.(sourceValue) ?? sourceValue
                        return [key, value]
                    }).filter(Boolean)
                )
            }))
        }
    }

    return DL
}
