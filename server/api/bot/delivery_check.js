import { validateAddress } from '#server/external/addressProvider/index.js'
import { findByLocation } from '#server/external/supplyArea.js'
import getShippingConfig from '#server/utils/data/getShippingConfig.js'
import { extractLimits, getMinSumForMethod } from '#common/functions/limits.js'
import formatISODate from '#common/functions/formatISODate.js'

const DAYS_AHEAD = 10

/**
 * POST /api/bot/delivery_check
 * Auth: API key with `bot:delivery` permission (router enforces).
 * Body: { city, street, building? }
 * - city+street required for accurate results (per dev feedback).
 * - zip/mikud is NOT supported (no zip field in address model) — if a
 *   `zip` param is sent it is rejected explicitly.
 * Returns: { hasService, city, street, building, shipping, minSum, deliveryDays }
 */
export default async function delivery_check(payload, { DL }) {
    const { city, street, building, domainId, zip, mikud, postalCode } = payload || {}

    if (zip || mikud || postalCode)
        throw { status: 400, message: 'Zip/postal-code lookup is not supported, send city and street', code: 'ZIP_UNSUPPORTED' }
    if (!city || !street) throw { status: 400, message: 'city and street required' }

    const validated = await validateAddress({
        DL,
        city,
        street,
        building: building || street
    })
    if (!validated?.location) throw { status: 404, message: 'address not found' }

    const area = await findByLocation(DL, validated.location).catch(() => null)
    const hasService = !!area
    const storeId = area?.stores?.[0]?.storeId || null

    // Shipping fees + minimums come from Settings (per-domain with default fallback)
    let shippingConfig = await getShippingConfig(DL, domainId)
    let limits = null
    try {
        const shippingSetting = domainId
            ? await DL.Setting.readOne({ key: 'shipping', domainId })
            : null
        const limitsSetting = domainId
            ? await DL.Setting.readOne({ key: 'limits', domainId })
            : await DL.Setting.readOne({ key: 'limits' })
        void shippingSetting
        const raw = limitsSetting?.value
        if (raw && typeof raw === 'object') limits = extractLimits({ limits: raw })
    } catch { }
    const minSum = limits ? getMinSumForMethod(limits, 'delivery') : 0

    // Next delivery days for the resolved store (read-only summary, no cart needed)
    let deliveryDays = []
    if (storeId) {
        try {
            const today = new Date()
            const end = new Date(today)
            end.setDate(end.getDate() + DAYS_AHEAD)
            const rows = await DL.OrderWindow.Model.find({
                storeId,
                date: { $gte: formatISODate(today), $lte: formatISODate(end) },
                active: true
            })
                .select({ _id: 0, date: 1, dayOfWeek: 1, start: 1, end: 1, leadTimestamp: 1, disabled: 1 })
                .sort({ date: 1, start: 1 })
                .lean()
            const now = Date.now()
            const byDate = {}
            for (const w of rows || []) {
                if (w.disabled) continue
                if (w.leadTimestamp && w.leadTimestamp < now) continue
                if (!byDate[w.date]) byDate[w.date] = { date: w.date, dayOfWeek: w.dayOfWeek, windows: [] }
                byDate[w.date].windows.push({ start: w.start, end: w.end, cutoff: w.leadTimestamp || null })
            }
            deliveryDays = Object.values(byDate)
        } catch { deliveryDays = [] }
    }

    return {
        hasService,
        city: validated.city || city,
        street: validated.street || street,
        building: validated.building || building || null,
        shipping: shippingConfig,
        minSum,
        deliveryDays
    }
}

delivery_check.config = {
    auth: 'none',
    permissions: ['bot:delivery'],
    required: ['city', 'street']
}
