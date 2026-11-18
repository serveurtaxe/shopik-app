import { loadEnvFile } from 'process'
import mongoose from 'mongoose'
import auditDbIndexes from './auditDbIndexes.js'

try {
    loadEnvFile()
} catch {
    // Container runs pass the environment directly
}

const uri = process.env.DB_URI || process.env.DB
if (!uri) {
    console.error('[runAuditDbIndexes] DB / DB_URI is not set')
    process.exit(1)
}

await mongoose.connect(uri)
console.log(`[runAuditDbIndexes] database: ${mongoose.connection.db.databaseName}`)
await auditDbIndexes({ db: mongoose.connection.db })
await mongoose.disconnect()
console.log('[runAuditDbIndexes] Done')
process.exit(0)
