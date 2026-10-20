import boot from '../boot.js'
import importBuyingPriceFile from './importBuyingPriceFile.js'

const args = process.argv.slice(2)
const hasFlag = name => args.includes(`--${name}`)
const valueOf = name => {
    const i = args.indexOf(`--${name}`)
    return i >= 0 ? args[i + 1] : undefined
}

const file = valueOf('file')

const options = {
    file,
    dryRun: hasFlag('dry-run')
}

if (!file) {
    console.error('--file <path> is required')
    process.exit(1)
}

const bootData = await boot()

console.log('[runImportBuyingPriceFile] Boot done', JSON.stringify(options))

await importBuyingPriceFile(bootData, options)

console.log('[runImportBuyingPriceFile] Done')
process.exit(0)
