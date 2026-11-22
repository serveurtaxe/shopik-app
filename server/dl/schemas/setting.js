import { CACHE_STRATEGIES } from '#common/constants.js'

const constants = {
    formType: {
        TEXT: 'text',
        CHECKBOX: 'checkbox',
        SWITCH: 'switch',
        COLOR: 'color',
        SELECT: 'select',
        FILE: 'file',
        IMAGE: 'image',
        TEXTAREA: 'textarea',
        DATE: 'date',
        INFO: 'info',
        LINK: 'link',
        CSS: 'css',
        CONFIG: 'config'
    },
    renderType: {
        STRING: 'string',
        TR: 'tr',
        IMAGE: 'image',
        COLOR: 'color',
        LIST: 'list',
        FIELD: 'field',
        NAME: 'name',
        ID: 'id',
        ADDRESS: 'address',
        DATE: 'date',
        TIME: 'time',
        DATETIME: 'datetime',
        BOOLEAN: 'boolean',
        V_BOOLEAN: 'v-boolean',
        COLOR_BOOLEAN: 'color-boolean',
        NIS: 'nis',
        COIN: 'coin',
        MR: 'mr',
        CONFIG: 'config'
    }
}

const settingSchema = {
    key: {
        type: String,
        required: true,
        filter: true
    },
    value: {},
    domainId: {
        type: String,
        required: true,
        filter: true
    },
    category: {
        type: String,
        required: true,
        lowercase: true,
        filter: true
    },
    subCategory: {
        type: String,
        required: true,
        lowercase: true,
        filter: true
    },
    formType: {
        type: String,
        enum: Object.values(constants.formType)
    },
    renderType: {
        type: String,
        enum: Object.values(constants.renderType)
    },
    // Image variant sizes for file/image uploads ({name: bounding width}).
    // Defaults to the standard l/m/s when absent, so a setting can declare its
    // own variants (e.g. appIcon's named PNGs, or seo.ogImage's single
    // convert-only `l` variant where the width is null).
    sizes: {
        type: Object
    },
    // Intrinsic pixel size of the current raster image, captured on upload.
    // Social crawlers get it as og:image:width/height; SSR cannot derive it
    // from the file URL.
    width: {
        type: Number
    },
    height: {
        type: Number
    },
    public: {
        type: Boolean,
        default: false,
        filter: true
    },
    hidden: {
        type: Boolean,
        default: false,
        filter: true
    }
}
const index = [
    [{ domainId: 1, key: 1 }, { unique: true }]
]

export const meta = { index, cacheStrategy: CACHE_STRATEGIES.HASHSET }

export default settingSchema