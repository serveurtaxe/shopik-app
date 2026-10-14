import boot from '../boot.js'

const seedName = process.argv[2]
if (!seedName) {
    console.log('Usage: node server/scripts/runSeed.js <seedModule>')
    process.exit(1)
}
const { default: seed } = await import(`./${seedName}.js`)

const { DL } = await boot()
console.log(`[runSeed:${seedName}] Boot done, seeding...`)
await seed({ DL })
console.log(`[runSeed:${seedName}] Done`)
process.exit(0)
