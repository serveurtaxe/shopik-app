import { planBarcodeAliases } from '#server/services/barcodeAliases/index.js'

/**
 * ייבוא שיוך ברקודים — attach secondary barcodes to a product from a CSV.
 *
 * `dryRun` defaults to true (the modal's "בדיקה בלבד" step); `dryRun: false`
 * applies every clean row. The service owns the whole plan/apply flow
 * (services/barcodeAliases/index.js), including the deleted_products snapshot
 * and the live guest-cart reference rewrite.
 *
 * POST /api/product/import_barcode_aliases { csv, dryRun? }
 */
export default function importBarcodeAliases(payload = {}, { DL, _admin }) {
    return planBarcodeAliases(
        {
            csv: payload.csv,
            dryRun: payload.dryRun !== false,
            adminId: _admin?.id
        },
        { DL }
    )
}

importBarcodeAliases.config = {
    required: ['csv'],
    permissions: ['product:update'],
    preventMultiple: true
}
