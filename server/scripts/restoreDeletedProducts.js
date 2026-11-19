/**
 * Restore product docs removed by the barcode-alias import.
 *
 * The import keeps the whole original document plus the owner's alias list
 * before the merge, so a restore is: re-insert the raw doc, then drop that
 * barcode from the owner's `scannableBarcodes`. Snapshots are kept (with
 * `restoredAt`) as an audit trail; a restored row is never inserted twice.
 *
 * Usage: node server/scripts/runRestoreDeletedProducts.js
 *          [--barcode <barcode>] [--main <mainBarcode>] [--all]
 *          [--dry-run] [--limit N]
 */
export default async function restoreDeletedProducts(
    { DL } = {},
    { barcode = '', mainBarcode = '', all = false, dryRun = false, limit = 0 } = {}
) {
    if (!DL?.DeletedProduct?.Model || !DL?.Product?.Model) throw new Error('DL required')
    if (!barcode && !mainBarcode && !all)
        throw new Error('choose what to restore: --barcode <barcode>, --main <mainBarcode> or --all')

    // `restoredAt` is not a schema filter field, so processFilter would drop it
    // and every snapshot would be offered again: filter it here instead.
    const filter = {}
    if (barcode) filter.barcode = barcode
    else if (mainBarcode) filter.mainBarcode = mainBarcode

    const rows = await DL.DeletedProduct.read(
        filter,
        {},
        { limit: 0, sort: { deletedAt: -1 } }
    )
    const cap = Number(limit) || 0
    const pending = (rows || []).filter(snapshot => !snapshot?.restoredAt)
    const snapshots = cap ? pending.slice(0, cap) : pending

    console.log(`[restoreDeletedProducts] ${snapshots.length} snapshot(s)${dryRun ? ' (DRY RUN — no writes)' : ''}`)
    const stats = { snapshots: snapshots.length, restored: 0, skipped: 0, errors: 0 }

    for (const snapshot of snapshots) {
        const targetBarcode = snapshot?.barcode
        const raw = snapshot?.product
        if (!targetBarcode || !raw) {
            stats.errors++
            console.warn(`[restoreDeletedProducts] snapshot ${snapshot?.id} has no barcode/product — skipped`)
            continue
        }

        const existing = await DL.Product.readOne({ barcode: targetBarcode }, { _id: 0, id: 1 })
        if (existing) {
            stats.skipped++
            console.log(`[restoreDeletedProducts] ${targetBarcode} already exists — skipped`)
            continue
        }

        if (dryRun) {
            stats.restored++
            console.log(`[restoreDeletedProducts] would restore ${targetBarcode} (main ${snapshot.mainBarcode || '-'})`)
            continue
        }

        try {
            // Raw insert: the snapshot is the exact stored shape, and Mongoose
            // strict mode would drop fields that are no longer in the schema.
            await DL.Product.Model.collection.insertOne(raw)
            stats.restored++

            if (snapshot.mainBarcode) {
                const owner = await DL.Product.readOne(
                    { barcode: snapshot.mainBarcode },
                    { _id: 0, id: 1, barcode: 1, scannableBarcodes: 1 }
                )
                if (owner) {
                    const aliases = (owner.scannableBarcodes || []).filter(alias => alias !== targetBarcode)
                    if (aliases.length !== (owner.scannableBarcodes || []).length)
                        await DL.Product.updateOne({ id: owner.id }, { scannableBarcodes: aliases })
                }
            }

            await DL.DeletedProduct.updateOne({ id: snapshot.id }, { restoredAt: new Date() })
            console.log(`[restoreDeletedProducts] restored ${targetBarcode}`)
        } catch (e) {
            stats.errors++
            console.error(`[restoreDeletedProducts] ${targetBarcode} failed:`, e?.message || e)
        }
    }

    console.log(`[restoreDeletedProducts] done ${JSON.stringify(stats)}`)
    return stats
}
