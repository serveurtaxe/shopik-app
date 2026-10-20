import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { addAddress, editAddress } from '../../server/utils/data/userAddress.js'
import { isElevatorRequired } from '../../common/functions/address.js'

const location = { type: 'Point', coordinates: [34.78, 32.08] }

const makeDL = (hasArea) => ({
    SupplyArea: {
        readOne: async () => hasArea ? { id: 'area-1' } : null
    }
})

const external = {
    geocode: {
        address: async (address) => ({
            city: address.city ?? 'city',
            street: address.street ?? 'street',
            building: address.building ?? 1,
            location
        })
    }
}

const address = { city: 'city', street: 'street', building: 1 }

describe('address service activation', () => {
    it('does not auto-activate the first address when it has no service', async () => {
        const geocoded = await addAddress({
            DL: makeDL(false),
            external,
            user: { addresses: [] },
            address
        })

        assert.equal(geocoded.hasService, false)
        assert.equal(geocoded.active, false)
    })

    it('auto-activates the first address when it has service', async () => {
        const geocoded = await addAddress({
            DL: makeDL(true),
            external,
            user: { addresses: [] },
            address
        })

        assert.equal(geocoded.hasService, true)
        assert.equal(geocoded.active, true)
    })

    it('does not activate a new address when another address is active', async () => {
        const geocoded = await addAddress({
            DL: makeDL(true),
            external,
            user: { addresses: [{ addressId: 'a', active: true }] },
            address
        })

        assert.equal(geocoded.active, false)
    })

    it('deactivates an active address when edited to a no-service location', async () => {
        const { geocoded, existingAddr } = await editAddress({
            DL: makeDL(false),
            external,
            user: { addresses: [{ addressId: 'a', active: true }] },
            addressId: 'a',
            address
        })

        assert.equal(existingAddr.active, true)
        assert.equal(geocoded.hasService, false)
        assert.equal(geocoded.active, false)
    })

    it('keeps an active address active when it still has service', async () => {
        const { geocoded } = await editAddress({
            DL: makeDL(true),
            external,
            user: { addresses: [{ addressId: 'a', active: true }] },
            addressId: 'a',
            address
        })

        assert.equal(geocoded.hasService, true)
        assert.equal(geocoded.active, true)
    })

    it('does not activate an inactive address', async () => {
        const { geocoded } = await editAddress({
            DL: makeDL(true),
            external,
            user: { addresses: [{ addressId: 'a', active: false }] },
            addressId: 'a',
            address
        })

        assert.equal(geocoded.hasService, true)
        assert.equal(geocoded.active, false)
    })
})

describe('elevator requirement', () => {
    it('requires an elevator above the fourth floor when hasElevator is false', () => {
        assert.equal(isElevatorRequired({ floor: '5', hasElevator: false }), true)
        assert.equal(isElevatorRequired({ floor: '4', hasElevator: false }), false)
        assert.equal(isElevatorRequired({ floor: '5', hasElevator: true }), false)
        assert.equal(isElevatorRequired({ floor: '', hasElevator: false }), false)
    })

    it('defaults hasElevator to true when not provided', async () => {
        const geocoded = await addAddress({
            DL: makeDL(true),
            external,
            user: { addresses: [] },
            address
        })

        assert.equal(geocoded.hasElevator, true)
    })

    it('rejects a no-elevator address above the fourth floor', async () => {
        await assert.rejects(
            () => addAddress({
                DL: makeDL(true),
                external,
                user: { addresses: [] },
                address: { ...address, floor: '5', hasElevator: false }
            }),
            err => err.code === 'ELEVATOR_REQUIRED'
        )
    })

    it('allows admins to save a no-elevator address above the fourth floor', async () => {
        const geocoded = await addAddress({
            DL: makeDL(true),
            external,
            user: { addresses: [] },
            address: { ...address, floor: '5', hasElevator: false },
            allowNoElevator: true
        })

        assert.equal(geocoded.hasElevator, false)
    })

    it('rejects editing an address into a no-elevator high floor', async () => {
        await assert.rejects(
            () => editAddress({
                DL: makeDL(true),
                external,
                user: { addresses: [{ addressId: 'a', active: true }] },
                addressId: 'a',
                address: { ...address, floor: '6', hasElevator: false }
            }),
            err => err.code === 'ELEVATOR_REQUIRED'
        )
    })
})
