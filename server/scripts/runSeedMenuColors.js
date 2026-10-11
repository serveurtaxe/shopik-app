import boot from '../boot.js'
import seedMenuColors from './seedMenuColors.js'

const { DL } = await boot()
console.log('[runSeedMenuColors] Boot done, seeding menu colors...')
await seedMenuColors({ DL })
console.log('[runSeedMenuColors] Done')
process.exit(0)
