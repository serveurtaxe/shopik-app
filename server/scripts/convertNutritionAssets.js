/**
 * Convert nutrition food-symbol source PNGs to bundled WebP assets.
 *
 * Drop source files into common/components/Nutrition/images named after the GS1
 * Food_Symbol_Red code (FSR2 sodium, FSR3 sugar, FSR4 saturated fat, FSR5 green
 * symbol — see FOOD_SYMBOLS in common/components/Nutrition/constants.js). Each
 * PNG is resized into a bounded box and written next to it as <code>.webp, which
 * the client bundles via import.meta.glob (common/components/Nutrition/images.js).
 *
 * PNG sources are gitignored (see images/.gitignore); only the WebPs ship.
 * Re-runnable: an output newer than its source is skipped unless --force.
 *
 * Usage: node server/scripts/convertNutritionAssets.js [--force]
 *          [--size 256] [--quality 80]
 */
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'

const root = path.resolve(import.meta.dirname, '..', '..')
const SRC_DIR = path.join(root, 'common', 'components', 'Nutrition', 'images')

export default async function convertNutritionAssets(
    { force = false, size = 256, quality = 80 } = {}
) {
    const box = Math.max(1, Number(size) || 256)
    const q = Math.min(100, Math.max(1, Number(quality) || 80))

    let entries
    try {
        entries = await fs.readdir(SRC_DIR)
    } catch {
        console.log(`[nutrition-assets] no images directory (${SRC_DIR}) — nothing to do`)
        return { converted: 0, skipped: 0, failed: 0 }
    }

    const pngs = entries.filter(f => /\.png$/i.test(f))
    const totals = { converted: 0, skipped: 0, failed: 0 }
    if (!pngs.length) {
        console.log(`[nutrition-assets] no PNG sources in ${SRC_DIR} — nothing to do`)
        return totals
    }

    for (const file of pngs) {
        const srcPath = path.join(SRC_DIR, file)
        const outPath = path.join(SRC_DIR, file.replace(/\.png$/i, '.webp'))
        try {
            if (!force) {
                const [srcStat, outStat] = await Promise.all([
                    fs.stat(srcPath),
                    fs.stat(outPath).catch(() => null)
                ])
                if (outStat && outStat.mtimeMs >= srcStat.mtimeMs) {
                    console.log(`[nutrition-assets] skip ${file} (webp up to date)`)
                    totals.skipped++
                    continue
                }
            }
            const info = await sharp(srcPath)
                .rotate()
                .resize({ width: box, height: box, fit: 'inside', withoutEnlargement: true })
                .webp({ quality: q })
                .toFile(outPath)
            console.log(`[nutrition-assets] ${file} -> ${path.basename(outPath)} (${info.width}x${info.height}, ${info.size} bytes)`)
            totals.converted++
        } catch (e) {
            console.log(`[nutrition-assets] FAILED ${file}: ${e?.message || e}`)
            totals.failed++
        }
    }
    console.log(`[nutrition-assets] done: converted=${totals.converted} skipped=${totals.skipped} failed=${totals.failed}`)
    return totals
}

export const paths = { SRC_DIR }
