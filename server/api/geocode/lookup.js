export default async function lookup(payload, { external }) {
    const q = payload.q?.trim()
    if (!q && (!payload.city || !payload.street || !payload.building))
        throw { status: 400, message: 'Provide a free-text address (q) or city+street+building' }
    const geocoded = q
        ? await external.geocode.address({ q })
        : await external.geocode.address({
            street: payload.street,
            building: payload.building,
            city: payload.city
        })

    if (!geocoded.location)
        throw { status: 400, message: 'Could not geocode this address' }

    return geocoded
}

lookup.config = {
    required: [],
    permissions: ['supply_area:read']
}