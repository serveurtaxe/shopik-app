import { getSmsConfig } from '#server/external/sms/config.js'
import resolveDomainId from '#server/utils/resolveDomainId.js'
import { isProdEnv } from '#server/utils/isProd.js'

export default async function getClientData(req, bootData) {
    const { utils } = bootData
    let user
    try {
        user = await utils.auth.getUser(req, bootData)
    } catch { }

    // Resolve the request domain for tenant-scoped settings (fail-open to
    // legacy unfiltered when unresolvable, e.g. no default domain yet).
    let domainId
    try {
        domainId = await resolveDomainId(req, bootData.DL)
    } catch { }

    const promises = [
        utils.data.getSettings({ ...bootData, domainId }),
        utils.data.getMenu({ ...bootData, req, _user: user }),
        utils.data.getPickupStores(bootData),
        getSmsConfig(bootData.DL, domainId).then(cfg => cfg.voice.enabled).catch(() => false),
    ]

    if (user) {
        promises.push(utils.data.getUserOrder({ ...bootData, _user: user }))
        promises.push(utils.data.getUserFavorites({ DL: bootData.DL, userId: user.id }))
    } else
        promises.push(utils.data.getGuestCart({ req, DL: bootData.DL }))
    const [
        settingsResult,
        menuResult,
        pickupStoresResult,
        voiceOtpResult,
        orderResult,
        favoritesResult
    ] = await Promise.allSettled(promises)

    if (settingsResult.status === 'rejected')
        console.log('settings error', settingsResult.reason)

    if (menuResult.status === 'rejected')
        console.log('menu error', menuResult.reason)

    const favorites = favoritesResult?.status === 'fulfilled' ? favoritesResult.value : []

    return {
        user: user ? { ...user, favorites } : user,
        order: orderResult?.status === 'fulfilled' ? orderResult.value : undefined,
        pickupStores: pickupStoresResult.status === 'fulfilled' ? pickupStoresResult.value : undefined,
        settings: settingsResult.status === 'fulfilled' ? settingsResult.value : undefined,
        menu: menuResult.status === 'fulfilled' ? menuResult.value : undefined,
        features: {
            // 019 voice-call OTP is a paid per-domain option (sms:019 VOICE.enabled).
            voiceOtp: voiceOtpResult.status === 'fulfilled' && voiceOtpResult.value === true,
        },
        env: {
            FILES_BASE_URL: process.env.FILES_BASE_URL || 'https://files.shopik.co.il',
            // Vee issued the accessibility sitekey for production only, so the
            // widget must not load in any non-production run — even when a dev
            // server falls back to the default domain and sees its settings.
            // Strict boolean on purpose (common/functions/vee.js compares !== true).
            PROD: isProdEnv(),
        },
    }
}