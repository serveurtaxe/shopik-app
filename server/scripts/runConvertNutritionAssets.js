import convertNutritionAssets from './convertNutritionAssets.js'

// Convert nutrition food-symbol PNGs to bundled WebP assets.
// Usage: node server/scripts/runConvertNutritionAssets.js [--force]
//          [--size N] [--quality N]
const args = process.argv.slice(2)
const flag = (name, def) => {
    const i = args.findIndex(a => a === `--${name}` || a.startsWith(`--${name}=`))
    if (i === -1) return def
    const eq = args[i].indexOf('=')
    if (eq !== -1) return args[i].slice(eq + 1)
    const next = args[i + 1]
    return next && !next.startsWith('--') ? next : true
}

await convertNutritionAssets({
    force: !!flag('force', false),
    size: Number(flag('size', 256)) || 256,
    quality: Number(flag('quality', 80)) || 80
})
process.exit(0)
