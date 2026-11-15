import DataManager from 'features/DataManager'
import styles from './coupons.module.css'

export default function Coupons({ }) {
    return <div className={styles.coupons}>
        <DataManager
            apiRoute='coupon'
            actions={['add', 'export', 'refresh']}
            defaultSort={{ updatedAt: -1 }}
            rowActions={['edit']}
            cols={[
                { key: 'code' },
                { key: 'name', type: 'name' },
                { key: 'description' },
                { key: 'department', type: 'tr' },
                { key: 'discount', type: 'number' },
                { key: 'minSum', type: 'coin' },
                { key: 'maxSum', type: 'coin' },
                { key: 'personal', type: 'boolean' },
                { key: 'benefit', type: 'tr' },
                { key: 'public', type: 'boolean' },
                { key: 'status', type: 'tr' },
                { key: 'start', type: 'date' },
                { key: 'end', type: 'date' },
                { key: 'dynamic', type: 'boolean' },
                { key: 'campaignName' },
                { key: 'adminName' },
                { key: 'createdAt', type: 'date' },
                { key: 'updatedAt', type: 'date' },
            ]}
            form={[
                { name: 'code', required: true },
                { name: 'name', required: true },
                { name: 'department', type: 'select', options: 'couponDepartments', required: true },
                { name: 'discount', type: 'number', required: true },
                { name: 'minSum', type: 'coin', required: true },
                { name: 'public', type: 'checkbox' },
                { name: 'personal', type: 'checkbox' },
                { name: 'benefit', type: 'select', options: 'couponBenefits', required: true },
                { name: 'start', type: 'date', required: true },
                { name: 'end', type: 'date', required: true },
            ]}
        />
    </div>
}
