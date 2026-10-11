import boot from '../boot.js'
import seedCategoryIcons from './seedCategoryIcons.js'

const { DL } = await boot()
console.log('[runSeedCategoryIcons] Boot done, seeding category icons...')
await seedCategoryIcons({ DL })
console.log('[runSeedCategoryIcons] Done')
process.exit(0)
