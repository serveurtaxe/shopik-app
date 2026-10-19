import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import getStoreForAddress from '../../server/utils/data/getStoreForAddress.js'

const location = { type: 'Point', coordinates: [35.21, 31.77] }

const makeDL = (area) => ({
    SupplyArea: {
        readOne: async () => area
    }
})

describe('getStoreForAddress', () => {
    it('returns the store assigned to the address supply area', async () => {
        const storeId = await getStoreForAddress({
            DL: makeDL({ stores: [{ storeId: 'store-1' }] }),
            address: { location }
        })

        assert.equal(storeId, 'store-1')
    })

    it('returns null when the address is outside every supply area', async () => {
        const storeId = await getStoreForAddress({
            DL: makeDL(null),
            address: { location }
        })

        assert.equal(storeId, null)
    })

    it('returns null when the supply area has no store', async () => {
        const storeId = await getStoreForAddress({
            DL: makeDL({ stores: [] }),
            address: { location }
        })

        assert.equal(storeId, null)
    })

    it('returns null for an address without a valid location', async () => {
        const storeId = await getStoreForAddress({
            DL: makeDL({ stores: [{ storeId: 'store-1' }] }),
            address: {}
        })

        assert.equal(storeId, null)
    })
})
