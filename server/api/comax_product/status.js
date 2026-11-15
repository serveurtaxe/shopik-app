import { hasValidKashrut } from '#common/components/Kashrut/constants.js'

// What the customer pays: the Comax price plus the deposit (trailing item)
// when the import resolved one. priceWithTrailing is written by the import;
// older rows without it fall back to the plain Comax price.
export function retailPrice(comax) {
    if (!(comax.price > 0)) return comax.price
    const withTrailing = Number(comax.priceWithTrailing)
    return Number.isFinite(withTrailing) && withTrailing > 0 ? withTrailing : comax.price
}

// Stable codes for every rule that can keep a product off the site. The report
// maps them to Hebrew text; tests assert the codes, not the wording.
export const STATUS_REASON = {
    COMAX_ARCHIVED: 'COMAX_ARCHIVED',
    NO_PRICE: 'NO_PRICE',
    NO_BUYING_PRICE: 'NO_BUYING_PRICE',
    NO_IMAGE: 'NO_IMAGE',
    NO_STORES: 'NO_STORES',
    NOT_IN_WEB: 'NOT_IN_WEB',
    CATEGORY_INACTIVE: 'CATEGORY_INACTIVE',
    SUBGROUP_HIDDEN: 'SUBGROUP_HIDDEN',
    KASHRUT_MISSING: 'KASHRUT_MISSING'
}

/**
 * The single product-status ladder. Shared by the nightly Comax sync and the
 * category-flag sweeps so a product can never be un-hidden by a rule that does
 * not know why it was hidden.
 *
 *   archived / no price                    -> archived (never resurrected)
 *   no image / in stock nowhere            -> hidden
 *   comax showInWeb off                    -> hidden
 *   category (or an ancestor) inactive     -> hidden
 *   sub-group showOnSite false             -> hidden
 *   sub-group requires kashrut, no valid   -> hidden
 *   otherwise                              -> active
 *
 * `flags` is the product's category_map row
 * ({ categoryActive, showOnSite, requireKashrut }); missing flags mean active,
 * shown and no kashrut requirement.
 *
 * Returns the first (most severe) failing status plus EVERY rule it violates,
 * in ladder order. The report needs the full list so the team can fix a row in
 * one pass instead of discovering the next blocker after each sync.
 */
export function explainStatus({ comax, existing, flags, status, enforceBuyingPrice = false }) {
    const reasons = []
    let current = status.ACTIVE

    const archive = reason => {
        reasons.push(reason)
        current = status.ARCHIVED
    }
    const hide = reason => {
        reasons.push(reason)
        if (current !== status.ARCHIVED) current = status.HIDDEN
    }

    if (comax.archived) archive(STATUS_REASON.COMAX_ARCHIVED)

    const price = retailPrice(comax)
    if (!(price > 0)) archive(STATUS_REASON.NO_PRICE)
    if (enforceBuyingPrice && !(comax.buyingPrice > 0)) archive(STATUS_REASON.NO_BUYING_PRICE)

    if (!(existing?.images?.product || []).length) hide(STATUS_REASON.NO_IMAGE)
    // A MISSING storeIds means it was never tracked and must not hide anything.
    if (Array.isArray(comax.storeIds) && comax.storeIds.length === 0) hide(STATUS_REASON.NO_STORES)
    if (!comax.showInWeb) hide(STATUS_REASON.NOT_IN_WEB)

    if (flags?.categoryActive === false) hide(STATUS_REASON.CATEGORY_INACTIVE)
    if (flags?.showOnSite === false) hide(STATUS_REASON.SUBGROUP_HIDDEN)
    if (flags?.requireKashrut === true && !hasValidKashrut(existing?.kashrut))
        hide(STATUS_REASON.KASHRUT_MISSING)

    return { status: current, reasons }
}

// Status-only view for the sync and the flag sweeps, which do not render the
// reasons. Keeping both entry points on one ladder is what stops them drifting.
export function deriveStatus(args) {
    return explainStatus(args).status
}
