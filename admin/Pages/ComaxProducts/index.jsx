import DataManager from 'features/DataManager'
import apiReq from 'common/functions/apiReq'
import { useModal } from 'common/components/Modal'
import { useNotificationCount } from 'features/Notifications'
import SalesWindowModal from './SalesWindowModal'
import Gs1MatchModal from './Gs1MatchModal'
import BackfillCatalogModal from './BackfillCatalogModal'

export default function ComaxProducts({ }) {
    const { openModal, closeModal } = useModal()
    const gs1Pending = useNotificationCount('comax.gs1Aliases')

    const gs1Matches = {
        icon: 'barcode',
        text: 'comax_gs1_matches',
        badge: gs1Pending,
        onClick: () => openModal(
            <Gs1MatchModal onClose={closeModal} />,
            { title: 'comax_gs1_matches' }
        ),
        permission: 'comax_product:update'
    }
    const salesWindow = {
        icon: 'settings',
        text: 'comax_products_sales_window',
        onClick: () => openModal(
            <SalesWindowModal onClose={closeModal} />,
            { title: 'comax_products_sales_window' }
        ),
        permission: 'comax_product:update'
    }
    const importProducts = {
        icon: 'download',
        text: 'comax_products_import',
        onClick: async ({ refresh }) => {
            await apiReq(`comax_product/import`)
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
    // The nightly import only brings what a store is stocking, so an item that
    // is out of stock everywhere has no row at all. This adds those rows from a
    // full-catalog export.
    const backfillCatalog = {
        icon: 'upload',
        text: 'comax_products_backfill',
        onClick: ({ refresh }) => openModal(
            <BackfillCatalogModal onDone={refresh} />,
            { title: 'comax_products_backfill' }
        ),
        permission: 'comax_product:update'
    }
    return <DataManager
        apiRoute='comax_product'
        actions={[importProducts, syncProducts, backfillCatalog, gs1Matches, salesWindow, 'export', 'refresh']}
        rowActions={['active']}
        defaultSort={{ lastImportedAt: -1 }}
        cols={[
            { key: 'barcode' },
            { key: 'name' },
            { key: 'description' },
            { key: 'price', type: 'coin' },
            { key: 'trailingItemId' },
            { key: 'trailingItemQuantity', type: 'number' },
            { key: 'trailingItemPrice', type: 'coin' },
            { key: 'trailingPrice', type: 'coin' },
            { key: 'priceWithTrailing', type: 'coin' },
            { key: 'isTrailingItem', type: 'boolean' },
            { key: 'buyingPrice', type: 'coin' },
            { key: 'superDepartment' },
            { key: 'department' },
            { key: 'group' },
            { key: 'subGroup' },
            { key: 'supplier' },
            { key: 'manufacturer' },
            { key: 'active', type: 'boolean' },
            { key: 'showInWeb', type: 'boolean' },
            { key: 'archived', type: 'boolean' },
            { key: 'syncedAt', type: 'date' },
            { key: 'lastImportedAt', type: 'date' },
        ]}
    />
}
