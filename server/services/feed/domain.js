import { normalizeHostname, rootHostname } from '#server/utils/normalizeDomain.js'

// The sitemap and Merchant feed are per-host documents, so the store is
// resolved strictly from the Host header. Deliberately NOT resolveDomainId:
// that helper falls back to `isDefault`, which would serve domain A's catalog
// on domain B's host — an SEO duplicate and a data leak.
//
// admin.*, localhost and unknown hosts answer 404.
export async function resolveFeedDomain(req, DL) {
    let host
    try {
        host = normalizeHostname(req?.headers?.host)
    } catch {
        return null
    }
    if (!host) return null
    if (/^(www\.)?admin\./.test(host)) return null

    const root = rootHostname(host)
    const domain = await DL.Domain.readOne(
        { url: root, active: true },
        { _id: 0, id: 1, name: 1, url: 1 }
    )
    if (!domain?.id) return null

    const canonical = domain.url || root
    return {
        domainId: domain.id,
        name: domain.name || 'Shopik',
        url: canonical,
        origin: `https://${canonical}`
    }
}

export default resolveFeedDomain
