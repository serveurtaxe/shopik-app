import { KASHRUT_VALID_CODES } from '#common/components/Kashrut/constants.js'

export function buildSyncFilter() {
    return {
        active: { $ne: false },
        // Deposit products are internal: they are referenced by a parent
        // product and charged through it, never sold as a catalog item.
        isTrailingItem: { $ne: true },
        superDepartmentCode: { $exists: true, $nin: ['12', null] },
        departmentCode: { $exists: true },
        groupCode: { $exists: true }
    }
}

function statuses(DL) {
    return DL.Product.constants.STATUS
}

/**
 * The buying-price requirement is armed only once buying prices were actually
 * imported — otherwise the first deploy would archive everything. Shared with
 * the catalog report so the "reason" it shows can never disagree with the sync.
 */
export async function shouldEnforceBuyingPrice(DL) {
    return await DL.ComaxProduct.count({ buyingPrice: { $gt: 0 } }) > 0
}

export async function hideActiveProduct({ DL, barcode }) {
    if (!barcode) return 0
    const { ACTIVE, HIDDEN } = statuses(DL)
    const res = await DL.Product.update(
        { barcode, status: ACTIVE },
        { status: HIDDEN }
    )
    return res?.modifiedCount || 0
}

export async function hideInactiveProducts({ DL, batchSize } = {}) {
    const BATCH = Number(batchSize || process.env.COMAX_SYNC_BATCH || 1000)
    const { ACTIVE, HIDDEN } = statuses(DL)
    const filter = { active: false, barcode: { $nin: [null, ''] } }

    let hidden = 0
    let afterBarcode = null

    // Keyset on the unique barcode, not skip: MongoDB bounds a blocking sort by
    // skip + limit, which the full catalog walks straight past (32MB limit).
    while (true) {
        const rows = await DL.ComaxProduct.read(
            afterBarcode ? { ...filter, barcode: { $gt: afterBarcode } } : filter,
            { _id: 0, barcode: 1 },
            { limit: BATCH, sort: { barcode: 1 } }
        )
        if (!rows?.length) break

        afterBarcode = rows[rows.length - 1]?.barcode

        const barcodes = rows.map(r => r.barcode).filter(Boolean)
        if (!barcodes.length) break

        const res = await DL.Product.update(
            { barcode: { $in: barcodes }, status: ACTIVE },
            { status: HIDDEN }
        )
        hidden += res?.modifiedCount || 0

        if (rows.length < BATCH) break
    }

    return hidden
}

/**
 * A product in no store cannot be sold. buildProduct already hides the rows
 * the sync visits, but a product whose Comax row disappeared (or never existed)
 * is never visited, so it would stay ACTIVE with an empty storeIds forever.
 * This sweep is the backstop: any ACTIVE product with no store becomes HIDDEN,
 * whatever its barcode or source.
 */
export async function hideStorelessProducts({ DL }) {
    const { ACTIVE, HIDDEN } = statuses(DL)
    const res = await DL.Product.update(
        { status: ACTIVE, 'storeIds.0': { $exists: false } },
        { status: HIDDEN }
    )
    return res?.modifiedCount || 0
}

async function flaggedCodes(DL, field, value) {
    const rows = await DL.CategoryMap.read(
        { [field]: value },
        { _id: 0, subGroupCode: 1 },
        { limit: 0 }
    )
    return (rows || []).map(row => String(row.subGroupCode)).filter(Boolean)
}

/**
 * Backstop for products the sync loop never visits (Comax row gone or filtered
 * out): an ACTIVE product whose sub-group is marked "hide on site", or whose
 * mapped category was deactivated, must not stay visible. Hide-only — nothing
 * is ever un-hidden here.
 */
export async function hideCategoryFlaggedProducts({ DL }) {
    // Two independent hide flags: Comax's showOnSite and the mirrored category
    // active state. Union the codes so a single update covers both.
    const codes = [...new Set([
        ...await flaggedCodes(DL, 'showOnSite', false),
        ...await flaggedCodes(DL, 'categoryActive', false)
    ])]
    if (!codes.length) return 0
    const { ACTIVE, HIDDEN } = statuses(DL)
    const res = await DL.Product.update(
        { status: ACTIVE, comaxSubGroupCode: { $in: codes } },
        { status: HIDDEN }
    )
    return res?.modifiedCount || 0
}

/**
 * Same backstop for kashrut: an ACTIVE product in a "kashrut required" sub-group
 * without a valid rabbinate code is hidden. A product becomes visible again only
 * when the sync ladder sees a valid code (never through this sweep).
 *
 * "without a valid code" must be negated at the array level: a plain
 * `rabbinates.code: { $nin: valid }` matches when ANY element is invalid, which
 * would hide a product that also carries a valid code (and fight the ladder,
 * which passes on ANY valid code via hasValidKashrut). $not + $elemMatch means
 * "no entry has a valid code", matching products with no kashrut at all, empty
 * rabbinates, name-only entries and legacy string kashrut too.
 */
export async function hideKashrutMissingProducts({ DL }) {
    const codes = await flaggedCodes(DL, 'requireKashrut', true)
    if (!codes.length) return 0
    const { ACTIVE, HIDDEN } = statuses(DL)
    const res = await DL.Product.update(
        {
            status: ACTIVE,
            comaxSubGroupCode: { $in: codes },
            'kashrut.rabbinates': { $not: { $elemMatch: { code: { $in: [...KASHRUT_VALID_CODES] } } } }
        },
        { status: HIDDEN }
    )
    return res?.modifiedCount || 0
}
