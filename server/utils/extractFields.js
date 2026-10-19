export function extractFields(payload, fields) {
    const values = fields.map(f => payload[f])
    fields.forEach(f => delete payload[f])
    return Object.fromEntries(fields.map((f, i) => [f.split('.').pop(), values[i]]))
}

const requiredAddressFields = ['address.city', 'address.street', 'address.building']
const addressFields = [...requiredAddressFields]
export function getAddress(payload) {
    if (payload?.address?.city && payload?.address?.street && payload?.address?.building)
        return payload.address
    if (requiredAddressFields.some(f => !payload[f]))
        return null
    const address = extractFields(payload, addressFields)
    return address
}

const nameFields = ['name.first', 'name.last']
export function getName(payload) {
    if (payload?.name?.first && payload?.name?.last)
        return payload.name

    const res = extractFields(payload, nameFields)
    if (!res.first && !res.last)
        return null
    return res
}

const extractors = { getAddress, getName }
export default extractors
