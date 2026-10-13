import { useEffect, useState } from 'react'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import Loader from 'common/components/Loader'
import apiReq from 'common/functions/apiReq'
import { useOrder } from 'features/Order/OrderProvider'
import Collapse from 'common/components/Collapse'
import { IoCheckmarkCircleOutline } from 'react-icons/io5'
import { LuTicketPercent, LuTag, LuTags } from 'react-icons/lu'
import styles from './couponSection.module.css'
import summaryStyles from '../orderSummary.module.css'
import { useText } from 'common/texts/TextProvider'
import { round2 } from '#common/functions/calcOrder/utils.js'

function formatDiscount(coupon, TR) {
    if (!coupon) return ''
    if (coupon.benefit === 'percent') return `${coupon.discount}%`
    return `₪${Number(coupon.discount).toFixed(0)}`
}

function formatMinSum(minSum, TR) {
    if (!minSum) return null
    const template = TR?.('coupon_min_above') || ''
    return template.replace('{minSum}', Number(minSum).toFixed(0))
}

function formatExpiry(end, TR) {
    if (!end) return null
    try {
        const d = new Date(end)
        if (isNaN(d)) return null
        const dd = String(d.getDate()).padStart(2, '0')
        const mm = String(d.getMonth() + 1).padStart(2, '0')
        const yy = d.getFullYear()
        const dateStr = `${dd}.${mm}.${yy}`
        const template = TR?.('coupon_valid_until') || ''
        return template.replace('{date}', dateStr)
    } catch { return null }
}

// Reusable card shell — used for regular coupons now, sale coupons later.
// Keeps same outer structure (dashed border, footer, CTA) so both types sit in same grid.
function RegularCouponCard({ coupon, isApplied, isActive = true, remainingToActivate = 0, isLoading, onApply, onRemove }) {
    const { TR } = useText() || {}
    const discountLabel = formatDiscount(coupon, TR)
    const minSumLabel = formatMinSum(coupon.minSum, TR)
    const expiryLabel = formatExpiry(coupon.end, TR)
    const discountSuffix = TR?.('coupon_discount_suffix') || ''

    return (
        <div className={`${styles.couponCard} ${styles.regularCard} ${isApplied ? styles.applied : ''} ${isApplied && !isActive ? styles.inactive : ''}`}>
            <div className={styles.cardTop}>
                <div className={styles.cardIconCircle}>
                    <LuTag className={styles.cardIcon} />
                </div>
                <Text bold size='l' className={styles.discountValue}>{discountLabel}{discountSuffix}</Text>
                {minSumLabel && <Text size='m' mode='sub' className={styles.minSum}>{minSumLabel}</Text>}
            </div>

            <div className={styles.cardBody}>
                <Text bold size='m' className={styles.cardName}>{coupon.name}</Text>
                {coupon.description && (
                    <Text size='m' mode='sub' className={styles.cardDesc}>{coupon.description}</Text>
                )}
            </div>

            <button
                type='button'
                className={`${styles.cardCta} ${isApplied ? styles.ctaApplied : ''} ${isApplied && !isActive ? styles.ctaInactive : ''}`}
                onClick={isApplied ? onRemove : onApply}
                disabled={isLoading}
            >
                {isLoading ? <Loader size={14} /> : isApplied ? (
                    isActive ? <><IoCheckmarkCircleOutline /> <Text size='m' bold>{TR?.('coupon_active') || ''}</Text></> : <Text size='m' bold>{TR?.('coupon_inactive') || ''}</Text>
                ) : (
                    <><LuTicketPercent /> <Text size='m' bold>{TR?.('coupon_apply') || ''}</Text></>
                )}
            </button>

            {expiryLabel && (
                <div className={styles.cardFooter}>
                    <Text size='m' mode='sub' className={styles.expiry}>{expiryLabel}</Text>
                    {coupon.maxSum && (
                        <Text size='m' mode='sub' className={styles.expiry}>{(TR?.('coupon_up_to') || '').replace('{maxSum}', Number(coupon.maxSum).toFixed(0))}</Text>
                    )}
                </div>
            )}
        </div>
    )
}

// Placeholder for future sale coupons — same shell, different inner content.
// Keeping file structure ready so sale type can be plugged without layout shift.
function SaleCouponCard({ coupon, isApplied, isActive, remainingToActivate, isLoading, onApply, onRemove }) {
    // For now renders same as regular if a sale coupon somehow arrives.
    // Intentionally separate component for future product-image layout.
    return <RegularCouponCard coupon={coupon} isApplied={isApplied} isActive={isActive} remainingToActivate={remainingToActivate} isLoading={isLoading} onApply={onApply} onRemove={onRemove} />
}

function CouponCard({ coupon, isApplied, isActive, remainingToActivate, isLoading, onApply, onRemove }) {
    if (coupon.sale) return <SaleCouponCard coupon={coupon} isApplied={isApplied} isActive={isActive} remainingToActivate={remainingToActivate} isLoading={isLoading} onApply={onApply} onRemove={onRemove} />
    return <RegularCouponCard coupon={coupon} isApplied={isApplied} isActive={isActive} remainingToActivate={remainingToActivate} isLoading={isLoading} onApply={onApply} onRemove={onRemove} />
}

export default function CouponSection() {
    const { order = {}, setOrder } = useOrder()
    const { TR } = useText() || {}
    const appliedCode = (order.coupons?.[0]?.code || '').toLowerCase()
    const [coupons, setCoupons] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    const [inputValue, setInputValue] = useState(appliedCode ? appliedCode.toUpperCase() : '')
    const [inputLoading, setInputLoading] = useState(false)
    const [inputError, setInputError] = useState(null)
    const [cardLoadingCode, setCardLoadingCode] = useState(null)
    const [isEditing, setIsEditing] = useState(!appliedCode)

    // keep input in sync when order changes externally
    useEffect(() => {
        const code = (order.coupons?.[0]?.code || '').toLowerCase()
        if (code) setInputValue(code.toUpperCase())
        else if (!inputLoading) {
            // don't overwrite while user is typing if no applied coupon
        }
    }, [appliedCode]) // eslint-disable-line

    // input open when no coupon, closed (edit button) when coupon exists
    useEffect(() => {
        if (appliedCode) setIsEditing(false)
        else setIsEditing(true)
    }, [appliedCode])

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        setError(null)
        apiReq('user/coupon', {})
            .then(res => {
                if (cancelled) return
                const list = res?.coupons || res || []
                setCoupons(Array.isArray(list) ? list : [])
            })
            .catch(e => {
                if (cancelled) return
                setError(e?.message || e)
                setCoupons([])
            })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [])

    async function handleApplyCode(codeRaw) {
        const code = (codeRaw || '').trim().toLowerCase()
        if (!code) { setInputError(TR?.('coupon_enter_code') || ''); return }
        if (appliedCode === code) return
        setInputError(null)
        // if another coupon already applied, remove it first (server only allows one)
        const isReplace = !!appliedCode
        const loaderCode = code
        setCardLoadingCode(loaderCode)
        setInputLoading(true)
        try {
            if (isReplace) {
                try { await apiReq('order/coupon/remove', { couponCode: appliedCode }) } catch { /* ignore */ }
            }
            const updated = await apiReq('order/coupon/add', { couponCode: code })
            // updated is filtered order
            if (updated?.id || updated?.coupons) {
                setOrder(prev => ({ ...prev, ...updated }))
            } else if (updated) {
                setOrder(prev => ({ ...prev, ...updated }))
            }
            setInputValue(code.toUpperCase())
        } catch (e) {
            const msg = typeof e === 'string' ? e : (e?.message || e?.details?.reason || TR?.('coupon_error_apply') || '')
            setInputError(msg)
        } finally {
            setInputLoading(false)
            setCardLoadingCode(null)
        }
    }

    async function handleRemoveCode(codeRaw) {
        const code = (codeRaw || appliedCode || '').trim().toLowerCase()
        if (!code) return
        setInputError(null)
        setInputLoading(true)
        setCardLoadingCode(code)
        try {
            const updated = await apiReq('order/coupon/remove', { couponCode: code })
            if (updated?.id !== undefined || updated?.coupons !== undefined) {
                setOrder(prev => ({ ...prev, ...updated, coupons: updated.coupons || [] }))
            } else {
                setOrder(prev => ({ ...prev, coupons: [] }))
            }
            setInputValue('')
        } catch (e) {
            const msg = typeof e === 'string' ? e : (e?.message || TR?.('coupon_error_remove') || '')
            setInputError(msg)
        } finally {
            setInputLoading(false)
            setCardLoadingCode(null)
        }
    }

    function handleCardApply(coupon) {
        if (appliedCode === coupon.code.toLowerCase()) {
            handleRemoveCode(coupon.code)
        } else {
            handleApplyCode(coupon.code)
        }
    }

    if (loading) {
        return (
            <Flex center className={styles.loadingWrap}>
                <Loader size={18} />
            </Flex>
        )
    }
    const hasCoupons = coupons && coupons.length > 0
    const appliedCoupon = order.coupons?.[0]
    return (
        <Flex col gap={12} className={styles.couponSection}>
            {hasCoupons && (
                <div className={styles.couponGrid}>
                    {coupons.map(c => {
                        const isApplied = appliedCode === c.code.toLowerCase()
                        const isActive = isApplied ? (appliedCoupon?.isActive !== false) : true
                        const remainingToActivate = isApplied && !isActive && appliedCoupon?.minSum ? Math.max(0, round2(Number(appliedCoupon.minSum) - Number(order.sum || 0))) : 0
                        return (
                            <CouponCard
                                key={c.code}
                                coupon={c}
                                isApplied={isApplied}
                                isActive={isActive}
                                remainingToActivate={remainingToActivate}
                                isLoading={cardLoadingCode === c.code.toLowerCase() || (inputLoading && appliedCode !== c.code.toLowerCase() && false)}
                                onApply={() => handleCardApply(c)}
                                onRemove={() => handleRemoveCode(c.code)}
                            />
                        )
                    })}
                </div>
            )}

            <div className={styles.inputRow}>
                <LuTicketPercent className={styles.couponRowIcon} />

                {isEditing ? (
                    <div className={styles.inputPillWrap}>
                        <input
                            id='checkout-coupon-input'
                            className={styles.couponInput}
                            value={inputValue}
                            onChange={e => { setInputValue(e.target.value.toUpperCase()); setInputError(null) }}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    e.preventDefault()
                                    if (appliedCode && inputValue.trim().toLowerCase() === appliedCode) {
                                        handleRemoveCode(inputValue)
                                    } else {
                                        handleApplyCode(inputValue)
                                    }
                                }
                                if (e.key === 'Escape' && appliedCode) setIsEditing(false)
                            }}
                            placeholder={TR?.('coupon_placeholder') || ''}
                            disabled={inputLoading}
                            autoComplete='off'
                            spellCheck={false}
                            autoFocus={!appliedCode}
                        />
                        {inputLoading ? (
                            <Loader size={14} />
                        ) : null}
                    </div>
                ) : (
                    <div className={styles.couponPillDisplay} onClick={() => setIsEditing(true)} role='button' tabIndex={0}>
                        <span className={styles.couponPillText}>{appliedCode.toUpperCase()}</span>
                    </div>
                )}

                {isEditing ? (
                    <div className={styles.outsideActions}>
                        {!inputLoading && inputValue && appliedCode !== inputValue.trim().toLowerCase() && (
                            <button type='button' className={styles.applyBtn} onClick={() => handleApplyCode(inputValue)}>
                                <Text size='s' bold>{TR?.('coupon_btn_apply') || ''}</Text>
                            </button>
                        )}
                        {appliedCode && !inputLoading && inputValue.trim().toLowerCase() === appliedCode && (
                            <button type='button' className={styles.removeBtn} onClick={() => handleRemoveCode(inputValue)}>
                                <Text size='s' bold>{TR?.('coupon_btn_remove') || ''}</Text>
                            </button>
                        )}
                        {appliedCode && (
                            <button type='button' className={styles.cancelEditBtn} onClick={() => setIsEditing(false)}>
                                <Text size='s'>{TR?.('coupon_btn_cancel') || ''}</Text>
                            </button>
                        )}
                    </div>
                ) : null}

                {appliedCode && !isEditing ? (
                    <button
                        type='button'
                        className={styles.editLabelBtn}
                        onClick={() => setIsEditing(true)}
                    >
                        <Text size='m' bold className={styles.editLabel}>{TR?.('edit_coupon') || ''}</Text>
                    </button>
                ) : (
                    !isEditing && <div className={styles.editLabelSpacer} />
                )}
            </div>

            {order.coupons?.[0]?.isActive === false && order.coupons[0].minSum && (
                <Text size='s' mode='error' className={styles.inactiveMsg}>{TR?.('coupon_min_sum_not_reached')?.replace('{remaining}', Math.max(0, round2(Number(order.coupons[0].minSum) - Number(order.sum || 0)))).replace('{minSum}', order.coupons[0].minSum)}</Text>
            )}
            {inputError && <Text size='s' mode='error' className={styles.inputError}>{inputError}</Text>}
        </Flex>
    )
}

// Hook for parent to know whether to render the Collapse wrapper
export function useAvailableCoupons() {
    const [hasCoupons, setHasCoupons] = useState(null)
    useEffect(() => {
        let cancelled = false
        apiReq('user/coupon', {})
            .then(res => {
                if (cancelled) return
                const list = res?.coupons || res || []
                setHasCoupons(Array.isArray(list) && list.length > 0)
            })
            .catch(() => { if (!cancelled) setHasCoupons(false) })
        return () => { cancelled = true }
    }, [])
    return hasCoupons
}

// Wrapper that includes the Collapse header — always visible so manual coupon entry works.
// Grid of personalized coupons is shown only when GET returns relevant coupons; input stays visible in all cases.
export function CouponCollapse({ defaultOpen = true }) {
    const { order = {}, setOrder } = useOrder()
    const { TR } = useText() || {}
    const appliedCode = (order.coupons?.[0]?.code || '').toLowerCase()
    const [open, setOpen] = useState(defaultOpen)
    const [cardLoadingCode, setCardLoadingCode] = useState(null)
    const [coupons, setCoupons] = useState(null)
    const [loading, setLoading] = useState(true)
    const [inputValue, setInputValue] = useState(appliedCode ? appliedCode.toUpperCase() : '')
    const [inputLoading, setInputLoading] = useState(false)
    const [inputError, setInputError] = useState(null)
    const [isEditing, setIsEditing] = useState(!appliedCode)

    // Sync with parent (e.g. mobile collapsed by default via defaultOpen)
    useEffect(() => { setOpen(defaultOpen) }, [defaultOpen])

    useEffect(() => {
        const code = (order.coupons?.[0]?.code || '').toLowerCase()
        if (code) setInputValue(code.toUpperCase())
    }, [appliedCode])

    useEffect(() => {
        if (appliedCode) setIsEditing(false)
        else setIsEditing(true)
    }, [appliedCode])

    useEffect(() => {
        let cancelled = false
        apiReq('user/coupon', {})
            .then(res => {
                if (cancelled) return
                const list = res?.coupons || res || []
                setCoupons(Array.isArray(list) ? list : [])
            })
            .catch(() => { if (!cancelled) setCoupons([]) })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [])

    async function handleApplyCode(codeRaw) {
        const code = (codeRaw || '').trim().toLowerCase()
        if (!code) { setInputError(TR?.('coupon_enter_code') || ''); return }
        if (appliedCode === code) return
        setInputError(null)
        const isReplace = !!appliedCode
        setCardLoadingCode(code)
        setInputLoading(true)
        try {
            if (isReplace) { try { await apiReq('order/coupon/remove', { couponCode: appliedCode }) } catch { } }
            const updated = await apiReq('order/coupon/add', { couponCode: code })
            if (updated) setOrder(prev => ({ ...prev, ...updated }))
            setInputValue(code.toUpperCase())
        } catch (e) {
            const msg = typeof e === 'string' ? e : (e?.message || e?.details?.reason || TR?.('coupon_error_apply') || '')
            setInputError(msg)
        } finally { setInputLoading(false); setCardLoadingCode(null) }
    }

    async function handleRemoveCode(codeRaw) {
        const code = (codeRaw || appliedCode || '').trim().toLowerCase()
        if (!code) return
        setInputError(null); setInputLoading(true); setCardLoadingCode(code)
        try {
            const updated = await apiReq('order/coupon/remove', { couponCode: code })
            if (updated) setOrder(prev => ({ ...prev, ...updated, coupons: updated.coupons || [] }))
            else setOrder(prev => ({ ...prev, coupons: [] }))
            setInputValue('')
        } catch (e) {
            const msg = typeof e === 'string' ? e : (e?.message || TR?.('coupon_error_remove') || '')
            setInputError(msg)
        } finally { setInputLoading(false); setCardLoadingCode(null) }
    }

    const hasCoupons = Array.isArray(coupons) && coupons.length > 0
    // No personalized coupons → grid header disabled + grayed, manual input stays enabled
    const couponsEmpty = !loading && !hasCoupons
    const effectiveOpen = couponsEmpty ? false : open

    if (loading) {
        return (
            <Collapse
                open={open}
                onToggle={setOpen}
                className={summaryStyles.summaryCollapse}
                title={
                    <Flex alignItems='center' gap={12}>
                        <div className={summaryStyles.iconCircle}>
                            <LuTicketPercent className={summaryStyles.rowIcon} />
                        </div>
                        <Text bold size='m' className={summaryStyles.rowText}>{TR?.('coupons_especially_for_you')}</Text>
                    </Flex>
                }
            >
                <Flex center className={styles.loadingWrap}><Loader size={18} /></Flex>
            </Collapse>
        )
    }
    // Always render the collapse — input must stay visible even when no personalized coupons.
    // Grid is shown only if GET returned relevant coupons; input is shown in all cases.

    return (<>
        <Collapse
            open={effectiveOpen}
            onToggle={couponsEmpty ? undefined : setOpen}
            showChevron={!couponsEmpty}
            className={couponsEmpty ? `${summaryStyles.summaryCollapse} ${styles.couponsDisabled}` : summaryStyles.summaryCollapse}
            headerClassName={couponsEmpty ? styles.couponsDisabledTop : ''}
            title={
                <Flex alignItems='center' gap={12}>
                    <div className={summaryStyles.iconCircle}>
                        <LuTags className={summaryStyles.rowIcon} />
                    </div>
                    <Text bold size='m' className={summaryStyles.rowText}>{TR?.('coupons_especially_for_you')}</Text>
                </Flex>
            }
        >
            <CouponSectionInner
                coupons={coupons}
                handleApplyCode={handleApplyCode}
                handleRemoveCode={handleRemoveCode}
                cardLoadingCode={cardLoadingCode}
                appliedCode={appliedCode}
            />
        </Collapse>

        <Flex col className={styles.inputSection}>
            <Flex className={styles.inputRow}>
                <LuTicketPercent className={styles.couponRowIcon} />

                {isEditing ? (
                    <div className={styles.inputPillWrap}>
                        <input
                            id='checkout-coupon-input-inner'
                            className={styles.couponInput}
                            value={inputValue}
                            onChange={e => { setInputValue(e.target.value.toUpperCase()); setInputError(null) }}
                            onKeyDown={e => {
                                if (e.key === 'Enter') {
                                    e.preventDefault()
                                    if (appliedCode && inputValue.trim().toLowerCase() === appliedCode) handleRemoveCode(inputValue)
                                    else handleApplyCode(inputValue)
                                }
                                if (e.key === 'Escape' && appliedCode) setIsEditing(false)
                            }}
                            placeholder={TR?.('coupon_placeholder') || ''}
                            disabled={inputLoading}
                            autoComplete='off'
                            spellCheck={false}
                            autoFocus
                        />
                        {inputLoading ? <Loader size={14} /> : null}
                    </div>
                ) : (
                    <div className={styles.couponPillDisplay} onClick={() => setIsEditing(true)} role='button' tabIndex={0}>
                        <span className={styles.couponPillText}>{appliedCode.toUpperCase()}</span>
                    </div>
                )}

                {isEditing ? (
                    <div className={styles.outsideActions}>
                        {!inputLoading && inputValue && appliedCode !== inputValue.trim().toLowerCase() && (
                            <button type='button' className={styles.applyBtn} onClick={() => handleApplyCode(inputValue)}><Text size='s' bold>{TR?.('coupon_btn_apply') || ''}</Text></button>
                        )}
                        {appliedCode && !inputLoading && inputValue.trim().toLowerCase() === appliedCode && (
                            <button type='button' className={styles.removeBtn} onClick={() => handleRemoveCode(inputValue)}><Text size='s' bold>{TR?.('coupon_btn_remove') || ''}</Text></button>
                        )}
                        {appliedCode && (
                            <button type='button' className={styles.cancelEditBtn} onClick={() => setIsEditing(false)}>
                                <Text size='s'>{TR?.('coupon_btn_cancel') || ''}</Text>
                            </button>
                        )}
                    </div>
                ) : null}

                {appliedCode && !isEditing ? (
                    <button type='button' className={styles.editLabelBtn} onClick={() => setIsEditing(true)}>
                        <Text size='m' bold className={styles.editLabel}>{TR?.('edit_coupon') || ''}</Text>
                    </button>
                ) : null}
            </Flex>

            {order.coupons?.[0]?.isActive === false && order.coupons[0].minSum && (
                <Text size='s' mode='error' className={styles.inactiveMsg}>{TR?.('coupon_min_sum_not_reached')
                    ?.replace('{remaining}', Math.max(0, round2(Number(order.coupons[0].minSum) - Number(order.sum || 0))))
                    .replace('{minSum}', order.coupons[0].minSum)}
                </Text>
            )}
        </Flex>
        {inputError && <Text size='s' mode='error' className={styles.inputError}>{inputError}</Text>}
    </>
    )
}

// Inner version that receives pre-fetched coupons — avoids double fetch when used via CouponCollapse
function CouponSectionInner({
    coupons: initialCoupons,
    handleApplyCode,
    handleRemoveCode,
    cardLoadingCode,
    appliedCode
}) {
    const [coupons] = useState(initialCoupons)
    const { order } = useOrder()
    const appliedCoupon = order.coupons?.[0]

    function handleCardApply(coupon) {
        if (appliedCode === coupon.code.toLowerCase()) handleRemoveCode(coupon.code)
        else handleApplyCode(coupon.code)
    }
    return (
        <Flex col gap={12} className={styles.couponSection}>
            {coupons && coupons.length > 0 && (
                <div className={styles.couponGrid}>
                    {coupons.map(c => {
                        const isApplied = appliedCode === c.code.toLowerCase()
                        const isActive = isApplied ? (appliedCoupon?.isActive !== false) : true
                        const remainingToActivate = isApplied && !isActive && appliedCoupon?.minSum ? Math.max(0, round2(Number(appliedCoupon.minSum) - Number(order.sum || 0))) : 0
                        return (
                            <CouponCard
                                key={c.code}
                                coupon={c}
                                isApplied={isApplied}
                                isActive={isActive}
                                remainingToActivate={remainingToActivate}
                                isLoading={cardLoadingCode === c.code.toLowerCase()}
                                onApply={() => handleCardApply(c)}
                                onRemove={() => handleRemoveCode(c.code)}
                            />
                        )
                    })}
                </div>
            )}
        </Flex>
    )
}
