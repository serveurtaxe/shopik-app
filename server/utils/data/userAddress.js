import uid from '#common/functions/uid.js'
import { findByLocation } from '#server/external/supplyArea.js'

// Shared address geocoding + area resolution used by both the client
// self-service endpoints (user/address/*, _user-scoped) and the admin
// endpoints (user/address/admin_*, userId-scoped).

export async function addAddress({ DL, external, user, address }) {
    const geocoded = await external.geocode.address(address)
    geocoded.addressId = uid()

    const area = await findByLocation(DL, geocoded.location)
    geocoded.areaId = area?.id ?? null
    geocoded.hasService = !!area

    const hasActiveAddress = user.addresses && user.addresses.some(a => a.active)
    geocoded.active = !hasActiveAddress && geocoded.hasService

    return geocoded
}

const sameLocationFields = [
    'city',
    'street',
    'building',
    'apartment',
    'residenceType'
]

export const isSameAddressLocation = (address1, address2) => {
    const sameFields = sameLocationFields.every(f =>
        address1[f] === address2[f]
    )
    const sameLocation = JSON.stringify(address1?.location?.coordinates) === JSON.stringify(address2.location?.coordinates)
    return sameFields && sameLocation
}

export async function editAddress({ DL, external, user, addressId, address }) {
    const existingAddr = (user.addresses || []).find(a => a.addressId === addressId)
    if (!existingAddr) throw { status: 404, message: 'address not found' }

    const geocoded = await external.geocode.address(address)
    geocoded.addressId = addressId
    geocoded.name = address.name ?? existingAddr.name
    if (!geocoded.location) geocoded.location = existingAddr.location

    const area = await findByLocation(DL, geocoded.location)
    geocoded.areaId = area?.id ?? null
    geocoded.hasService = !!area
    geocoded.active = existingAddr.active && geocoded.hasService

    return { geocoded, existingAddr }
}
