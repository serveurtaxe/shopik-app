import { CACHE_STRATEGIES } from '#common/constants.js'

const categorySchema = {
    name: {
        type: String,
        required: true,
        maxlength: 100,
        minlength: 2,
        trim: true
    },
    slug: String,
    icon: String,
    path: String,
    parentId: String,
    parentIds: [String]
}

export const meta = { cacheStrategy: CACHE_STRATEGIES.HASHSET }

export default categorySchema
