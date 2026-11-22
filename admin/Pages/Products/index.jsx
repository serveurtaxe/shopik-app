import DataManager from 'features/DataManager'
import { useModal } from 'common/components/Modal'
import LoadKashrutModal from './LoadKashrutModal'
import LoadImagesModal from './LoadImagesModal'
import LoadBarcodeAliasesModal from './LoadBarcodeAliasesModal'
import styles from './products.module.css'

export default function Products({ }) {
    const { openModal } = useModal()

    // First so it sits at the top of the ⋯ menu: it is the tool that fixes the
    // kashrut stamps admins ask about most.
    const loadKashrut = {
        icon: 'upload',
        text: 'action_load_kashrut',
        permission: 'product:update',
        onClick: ({ refresh }) => openModal(
            <LoadKashrutModal onDone={refresh} />,
            { title: 'product_load_kashrut' }
        )
    }

    const loadImages = {
        icon: 'upload',
        text: 'action_load_images',
        permission: 'product:update',
        onClick: ({ refresh }) => openModal(
            <LoadImagesModal onDone={refresh} />,
            { title: 'product_load_images' }
        )
    }

    const loadBarcodeAliases = {
        icon: 'upload',
        text: 'action_load_barcode_aliases',
        permission: 'product:update',
        onClick: ({ refresh }) => openModal(
            <LoadBarcodeAliasesModal onDone={refresh} />,
            { title: 'product_load_barcode_aliases' }
        )
    }

    return <div className={styles.products}>
        <DataManager
            apiRoute='product'
            actions={[loadKashrut, loadImages, loadBarcodeAliases, 'add', 'export', 'refresh']}
            defaultSort={{ updatedAt: -1 }}
            rowActions={['edit']}
            onRowClick={console.log}
            cols={[
                { key: 'image' },
                { key: 'barcode' },
                { key: 'name' },
                { key: 'label' },
                { key: 'category.title' },
                { key: 'vat', type: 'boolean' },
                { key: 'createdAt', type: 'date' },
                { key: 'updatedAt', type: 'datetime' },
                { key: 'active', type: 'boolean' },
            ]}
            form={[
                { name: 'barcode', required: true },
                { name: 'name', required: true },
                { name: 'label', required: true },
                { name: 'category.title', required: true },
            ]}
        />
    </div>
}
