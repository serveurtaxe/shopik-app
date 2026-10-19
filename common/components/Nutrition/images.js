// Bundled food-symbol stamp images live in ./images, named after the GS1
// Food_Symbol_Red code (FSR2 sugar, FSR3 sodium, FSR4 saturated fat, FSR5
// green symbol) or the symbol key (positive/sodium/sugar/fat). Vite globs them
// at build time; a missing file simply renders nothing (icons are unaffected).
const modules = import.meta.glob('./images/*.webp', { eager: true, import: 'default' })

const IMAGE_BY_NAME = (() => {
    const map = {}
    for (const [path, url] of Object.entries(modules)) {
        const name = path.split('/').pop().replace(/\.webp$/i, '')
        if (name) map[name] = url
    }
    return map
})()

export function getFoodSymbolImage(symbol) {
    if (!symbol) return ''
    return IMAGE_BY_NAME[String(symbol.code)] || IMAGE_BY_NAME[String(symbol.key)] || ''
}

export default { getFoodSymbolImage }
