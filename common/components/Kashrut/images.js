// Bundled stamp images live in ./images, named after the group's primary GS1
// code (e.g. 67085.webp) — see KASHRUT_RABBINATES in ./constants.js. Vite globs
// them at build time; an empty folder is valid, in which case every stamp falls
// back to its text label.
const modules = import.meta.glob('./images/*.webp', { eager: true, import: 'default' })

const IMAGE_BY_CODE = (() => {
    const map = {}
    for (const [path, url] of Object.entries(modules)) {
        const name = path.split('/').pop().replace(/\.webp$/i, '')
        if (name) map[name] = url
    }
    return map
})()

export function getKashrutImage(stampCode) {
    if (!stampCode) return ''
    return IMAGE_BY_CODE[String(stampCode)] || ''
}

export default { getKashrutImage }
