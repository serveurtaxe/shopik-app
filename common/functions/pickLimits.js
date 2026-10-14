// Pick deviation limits for the ops picking flow.
// Values come from the `pickLimits` setting (per domainId); these defaults
// are the fail-open fallback when the setting row is missing or invalid.
// Units: percentages as whole numbers (30 = 30%), qty allowance in absolute units.
export const DEFAULT_PICK_LIMITS = {
    weightUpPct: 30,
    weightDownPct: 20,
    qtyUpAbs: 5,
}

const EPS = 1e-9

function toPositiveNumber(v, fallback) {
    const n = Number(v)
    if (!isFinite(n) || n < 0) return fallback
    return n
}

export function normalizePickLimits(raw) {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_PICK_LIMITS }
    return {
        weightUpPct: toPositiveNumber(raw.weightUpPct, DEFAULT_PICK_LIMITS.weightUpPct),
        weightDownPct: toPositiveNumber(raw.weightDownPct, DEFAULT_PICK_LIMITS.weightDownPct),
        qtyUpAbs: toPositiveNumber(raw.qtyUpAbs, DEFAULT_PICK_LIMITS.qtyUpAbs),
    }
}

// Returns { min, max } of allowed *supplied* amounts for an ordered qty.
// Weight products: ordered*(1-down) .. ordered*(1+up).
// Quantity products: no lower bound enforced here (0/short goes through the
// separate "missing" flow); upper bound is ordered + qtyUpAbs.
// Returns null when ordered is not a positive number (caller: don't block).
export function getPickRange(ordered, isWeight, limits = DEFAULT_PICK_LIMITS) {
    const o = Number(ordered)
    if (!isFinite(o) || o <= 0) return null
    const { weightUpPct, weightDownPct, qtyUpAbs } = normalizePickLimits(limits)
    if (isWeight) {
        return {
            min: o * (1 - weightDownPct / 100),
            max: o * (1 + weightUpPct / 100),
        }
    }
    return { min: 0, max: o + qtyUpAbs }
}

export function isPickInRange(supplied, ordered, isWeight, limits = DEFAULT_PICK_LIMITS) {
    const s = Number(supplied)
    if (!isFinite(s)) return false
    const range = getPickRange(ordered, isWeight, limits)
    if (!range) return true
    return s + EPS >= range.min && s - EPS <= range.max
}
