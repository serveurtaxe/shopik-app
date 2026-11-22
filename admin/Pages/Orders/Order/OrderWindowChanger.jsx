import { useState } from 'react'
import apiReq from 'common/functions/apiReq'
import useApi from 'common/functions/useApi'
import usePermission from 'common/permissions/usePermision'
import { useText } from 'common/texts/TextProvider'
import { formatWindow } from 'Pages/Ops/orderUtils'
import Button from 'common/components/Button'
import Popover from 'common/components/Popover'
import WindowPicker from 'common/components/WindowPicker'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Loader from 'common/components/Loader'
import { useModal } from 'common/components/Modal'
import styles from './order.module.css'

export default function OrderWindowChanger({ order, onChanged }) {
    const { TR } = useText()
    const canEdit = usePermission('order:update')
    const { data, loading, error, callReq } = useApi(
        'order/window/admin_options',
        { orderId: order.id },
        { hold: true }
    )
    const [loadingId, setLoadingId] = useState(null)
    const [chooseError, setChooseError] = useState('')
    const { openModal } = useModal()

    function openFullConfirm(window, close) {
        openModal(
            <FullWindowConfirm
                order={order}
                window={window}
                onDone={async () => {
                    close?.()
                    await onChanged?.()
                }}
            />,
            { title: 'change_window' }
        )
    }

    async function apply(window, close, allowFull = false) {
        if (loadingId) return
        setLoadingId(window.id)
        setChooseError('')
        try {
            await apiReq('order/window/admin_choose', {
                orderId: order.id,
                windowId: window.id,
                allowFull: allowFull || undefined
            })
            close?.()
            await onChanged?.()
        } catch (e) {
            // The capacity can fill between opening the picker and choosing.
            if (e?.code === 'WINDOW_FULL' && !allowFull) {
                openFullConfirm(window, close)
                return
            }
            setChooseError(e?.message || 'change_window_failed')
        } finally {
            setLoadingId(null)
        }
    }

    async function choose(window, close) {
        if (window.id === order.window?.id || loadingId) return

        const flags = window.flags || {}
        const isFull = flags.full ?? window.note === 'full'
        const onlyCapacityFull = isFull && !flags.past && !flags.closed && !flags.special

        if (window.disabled && !onlyCapacityFull) return
        if (onlyCapacityFull) {
            openFullConfirm(window, close)
            return
        }

        await apply(window, close)
    }

    function openPicker() {
        setChooseError('')
        callReq()
    }

    if (!canEdit) return null

    return <Popover
        modal={false}
        button={<Button
            mode='text'
            icon='edit'
            tooltip={TR?.('change_window')}
            className={styles.windowChangeBtn}
            onClick={openPicker}
        />}
    >
        {({ close }) => <Flex col gap={12} className={styles.windowPickerBody}>
            {loading && !data
                ? <Loader />
                : data?.length
                    ? <WindowPicker
                        days={data}
                        activeWindowId={order.window?.id}
                        loadingId={loadingId}
                        onSelect={window => choose(window, close)}
                    />
                    : !loading && !error && <Text size='s' mode='sub'>{'windows_no_windows_for_order'}</Text>}
            {error ? <Text size='s' mode='error'>{typeof error === 'string' ? error : error.message || 'change_window_failed'}</Text> : null}
            {chooseError ? <Text size='s' mode='error'>{chooseError}</Text> : null}
        </Flex>}
    </Popover>
}

function FullWindowConfirm({ order, window, onDone }) {
    const { TR } = useText()
    const { closeModal } = useModal()
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState('')

    async function confirm() {
        if (loading) return
        setLoading(true)
        setError('')
        try {
            await apiReq('order/window/admin_choose', {
                orderId: order.id,
                windowId: window.id,
                allowFull: true
            })
            closeModal()
            await onDone?.()
        } catch (e) {
            setError(e?.message || 'change_window_failed')
        } finally {
            setLoading(false)
        }
    }

    return <Flex col gap={20} center>
        <Text size='l' bold center>{`${TR('change_window')}: ${formatWindow(window).dayText}`}</Text>
        <Text size='m' center>{'change_window_full_message'}</Text>
        <Text size='s' mode='sub' center>{'change_window_full_warning'}</Text>
        {error ? <Text size='s' mode='error' center>{error}</Text> : null}
        <Flex gap={20} center>
            <Button loading={loading} onClick={confirm}>{'confirm'}</Button>
            <Button mode='outline' disabled={loading} onClick={closeModal}>{'cancel'}</Button>
        </Flex>
    </Flex>
}
