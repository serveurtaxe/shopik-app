import { normalizePickLimits, DEFAULT_PICK_LIMITS } from '#common/functions/pickLimits.js'

// Server source of truth for pick deviation limits.
// Reads the per-domain `pickLimits` setting ({ weightUpPct, weightDownPct, qtyUpAbs });
// falls back to hardcoded defaults when the row is missing, invalid, or unreadable
// so picking is never blocked by a settings problem.
export default async function getPickLimits(DL, domainId) {
    try {
        if (!domainId) return { ...DEFAULT_PICK_LIMITS }
        const setting = await DL.Setting.readOne({ key: 'pickLimits', domainId })
        if (!setting?.value || typeof setting.value !== 'object') return { ...DEFAULT_PICK_LIMITS }
        return normalizePickLimits(setting.value)
    } catch {
        return { ...DEFAULT_PICK_LIMITS }
    }
}
