import { buildGeocodeKey, normalizeAddressParts } from './addressProvider/geocodeKey.js'

const GOOGLE_MAPS_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'
const CACHE_MONTHS = { RANGE_INTERPOLATED: 3 }

const LOCATION_TYPE_RANK = {
    ROOFTOP: 0,
    RANGE_INTERPOLATED: 1,
    GEOMETRIC_CENTER: 2,
    APPROXIMATE: 3
}

function hasComponent(result, type) {
    return (result.address_components || []).some(c => c.types?.includes(type))
}

function hasStreetComponent(result) {
    return hasComponent(result, 'route') || hasComponent(result, 'street_address')
}

function pickBestResult(results) {
    const streetLevel = results.filter(hasStreetComponent)
    const pool = streetLevel.length
        ? streetLevel
        : results.filter(r => !(r.types || []).includes('country'))
    if (!pool.length) return results[0]

    return pool.reduce((best, cur) => {
        const bestRank = LOCATION_TYPE_RANK[best.geometry?.location_type] ?? 9
        const curRank = LOCATION_TYPE_RANK[cur.geometry?.location_type] ?? 9
        if (curRank !== bestRank) return curRank < bestRank ? cur : best
        if (hasComponent(cur, 'street_number') !== hasComponent(best, 'street_number'))
            return hasComponent(cur, 'street_number') ? cur : best
        return best
    })
}

function isExpired(hit) {
    const months = CACHE_MONTHS[hit?.accuracy]
    if (!months) return false
    const at = new Date(hit.updatedAt || hit.createdAt)
    if (Number.isNaN(at.getTime())) return true
    const cutoff = new Date()
    cutoff.setMonth(cutoff.getMonth() - months)
    return at < cutoff
}

async function fetchFromGoogle(address) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY
    if (!apiKey)
        throw new Error('Missing Google Maps API Key')

    const addressString = address.q?.trim()
        ? address.q.trim()
        : `${address.street} ${address.building}, ${address.city}`

    const params = new URLSearchParams({
        address: addressString,
        components: 'country:IL',
        key: apiKey
    })

    const response = await fetch(`${GOOGLE_MAPS_GEOCODE_URL}?${params}`)

    if (!response.ok) {
        throw new Error(`Geocoding failed with status: ${response.status}`)
    }

    const data = await response.json()

    if (data.status !== 'OK' || !data.results.length)
        return address

    const result = pickBestResult(data.results)

    const { lat, lng } = result.geometry.location

    return {
        ...address,
        location: {
            type: 'Point',
            coordinates: [lng, lat]
        },
        accuracy: result.geometry.location_type
    }
}

function geocodeFactory({ DL }) {
    async function address(input) {
        const key = buildGeocodeKey(input || {})
        if (key && DL?.GeocodeCache) {
            try {
                const hit = await DL.GeocodeCache.readById(key)
                if (hit?.location?.coordinates?.length && !isExpired(hit))
                    return { ...input, location: hit.location, accuracy: hit.accuracy || 'ROOFTOP', source: 'cache' }
            } catch {}
        }

        const res = await fetchFromGoogle(input)

        const cacheable = res?.accuracy === 'ROOFTOP' || res?.accuracy === 'RANGE_INTERPOLATED'
        if (key && res?.location?.coordinates?.length && cacheable && DL?.GeocodeCache) {
            try {
                const parts = normalizeAddressParts(input)
                await DL.GeocodeCache.updateOne({ id: key }, {
                    id: key,
                    ...parts,
                    location: res.location,
                    accuracy: res.accuracy
                }, { upsert: true })
            } catch (e) {
                console.warn('[geocode-cache] write failed', e?.message || e)
            }
        }

        return res
    }

    return { address }
}

export default geocodeFactory
export { fetchFromGoogle }
