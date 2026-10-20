import DataManager from 'features/DataManager'
import apiReq from 'common/functions/apiReq'

export default function ComaxProducts({ }) {
    const importProducts = {
        icon: 'download',
        text: 'comax_products_import',
        onClick: async ({ refresh }) => {
            await apiReq(`comax_product/import`)
            refresh?.()
        },
        permission: 'comax_product:update'
    }
    const importBuyingPrices = {
        icon: 'download',
        text: 'comax_products_buying_price_import',
        onClick: async ({ refresh }) => {
            await apiReq(`comax_product/import_buying_price`)
            refresh?.()
        },
        permission: 'comax_product:update'
    }
    const syncProducts = {
        icon: 'sync',
        text: 'comax_products_sync',
        onClick: async ({ refresh }) => {
            await apiReq(`comax_product/sync`)
            refresh?.()
        },
        permission: 'comax_product:update'
    }
    const syncStock = {
        icon: 'stockSync',
        text: 'comax_products_stock_sync',
        onClick: async ({ refresh }) => {
            await apiReq(`cash_register/sync`, {})
            refresh?.()
        },
        permission: 'cash_register:sync'
    }
    return <DataManager
        apiRoute='comax_product'
        actions={[importProducts, importBuyingPrices, syncProducts, syncStock, 'export', 'refresh']}
        defaultSort={{ lastImportedAt: -1 }}
        cols={[
            { key: 'barcode' },
            { key: 'name' },
            { key: 'description' },
            { key: 'price', type: 'coin' },
            { key: 'buyingPrice', type: 'coin' },
            { key: 'superDepartment' },
            { key: 'department' },
            { key: 'group' },
            { key: 'subGroup' },
            { key: 'supplier' },
            { key: 'manufacturer' },
            { key: 'showInWeb', type: 'boolean' },
            { key: 'archived', type: 'boolean' },
            { key: 'syncedAt', type: 'date' },
            { key: 'lastImportedAt', type: 'date' },
        ]}
    />
}
