import { CACHE_STRATEGIES } from '#common/constants.js'

const categorySchema = {
    // Stable site code from the category-map CSV (unique across the whole tree).
    code: { type: String, filter: 'exact' },
    name: {
        type: String,
        required: true,
        maxlength: 100,
        minlength: 2,
        trim: true
    },
    // Slug and the menu path below it derive from the name, and `category/rename`
    // recomputes them for the whole branch.
    slug: String,
    icon: String,
    path: String,
    parentId: String,
    parentIds: [String],
    // 1 = top-level menu item, 2 = sub menu, 3 = leaf.
    level: { type: Number, filter: true },
    // Admin ordering within the same parent (drag & drop); an import sets it
    // from the row order of the category CSV.
    sortOrder: { type: Number, default: 0 }
}

export const meta = {
    cacheStrategy: CACHE_STRATEGIES.HASHSET,
    index: [
        { code: 1 },
        { path: 1 },
        { parentId: 1, sortOrder: 1 }
    ]
}

export default categorySchema
