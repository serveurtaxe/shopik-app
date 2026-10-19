import { findByLocation } from '#server/external/supplyArea.js'

// Resolves the store that serves a delivery address through its supply area.
// The area's assigned store is authoritative — geographic proximity is not.
export default async function getStoreForAddress({ DL, address }) {
    const area = await findByLocation(DL, address?.location)
    return area?.stores?.[0]?.storeId ?? null
}
