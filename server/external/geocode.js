import { buildGeocodeKey, normalizeAddressParts } from './addressProvider/geocodeKey.js'

const GOOGLE_MAPS_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json'

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

    const controller = new AbortController()
    const timeoutMs = Number(process.env.GEOCODE_TIMEOUT_MS || 10000)
    const t = setTimeout(() => controller.abort(), timeoutMs)
    let response
    try {
        response = await fetch(`${GOOGLE_MAPS_GEOCODE_URL}?${params}`, { signal: controller.signal })
    } catch (e) {
        if (e?.name === 'AbortError') throw new Error('Geocoding timed out')
        throw e
    } finally {
        clearTimeout(t)
    }

    if (!response.ok) {
        throw new Error(`Geocoding failed with status: ${response.status}`)
    }

    const data = await response.json()

    if (data.status !== 'OK' || !data.results.length)
        return address

    const [result] = data.results

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
                if (hit?.location?.coordinates?.length)
                    return { ...input, location: hit.location, accuracy: 'ROOFTOP', source: 'cache' }
            } catch {}
        }

        const res = await fetchFromGoogle(input)

        if (key && res?.location?.coordinates?.length && res?.accuracy === 'ROOFTOP' && DL?.GeocodeCache) {
            try {
                const parts = normalizeAddressParts(input)
                await DL.GeocodeCache.create({
                    id: key,
                    ...parts,
                    location: res.location,
                    accuracy: 'ROOFTOP'
                })
            } catch (e) {
                if (e?.code !== 11000) console.warn('[geocode-cache] write failed', e?.message || e)
            }
        }

        return res
    }

    return { address }
}

export default geocodeFactory
export { fetchFromGoogle }
