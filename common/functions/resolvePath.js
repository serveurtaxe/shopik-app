import toSlug from './toSlug.js'

export default function resolvePath(item, basePath) {
    return item?.path || `${basePath}/${toSlug(item?.name)}`
}
