import { useEffect, useMemo, useRef, useState } from 'react'
import { useLists } from 'common/features/Lists'
import { useUser } from 'features/User'
import Button from 'common/components/Button'
import Select from 'common/components/Select'
import Text from 'common/components/Text'
import { useText } from 'common/texts/TextProvider'
import useApi from 'common/functions/useApi'
import apiReq from 'common/functions/apiReq'
import renderOrderSmsTemplate from 'common/functions/renderOrderSmsTemplate'
import {
    DEFAULT_ORDER_SMS_TEMPLATES,
    ORDER_SMS_CATEGORY,
    ORDER_SMS_METHODS,
    ORDER_SMS_STAGES,
    ORDER_SMS_SUB_CATEGORY,
    ORDER_SMS_TEMPLATE_KEYS,
    ORDER_SMS_VARIABLES
} from 'common/constants/orderSms.js'
import styles from './smsTemplates.module.css'

const SAMPLE_VALUES = {
    customer_first_name: 'דוד',
    order_number: '100245',
    delivery_date: '22/10/2026',
    delivery_window_start: '14:00',
    delivery_window_end: '16:00',
    order_link: 'https://shefa.click/account/orders',
    pickup_store_name: 'סניף ירושלים'
}

function stageTitleKey(method, stage) {
    const methodKey = typeof method === 'string' ? method : method?.key
    const suffix = stage.key === 'shipped' || stage.key === 'done' ? `_${methodKey}` : ''
    return `order_sms_stage_${stage.key}${suffix}`
}

function stageDescriptionKey(stage) {
    return `order_sms_stage_${stage.key}_description`
}

function buildTemplates(settings) {
    const byKey = Object.fromEntries((settings || []).map(setting => [setting.key, setting]))
    const templates = {}
    const originals = {}
    for (const method of ORDER_SMS_METHODS) {
        for (const stage of ORDER_SMS_STAGES) {
            const key = ORDER_SMS_TEMPLATE_KEYS[method.key][stage.key]
            const saved = byKey[key]?.value
            const value = typeof saved === 'string' && saved.trim() ? saved : DEFAULT_ORDER_SMS_TEMPLATES[method.key][stage.key]
            templates[key] = value
            originals[key] = value
        }
    }
    return { byKey, templates, originals }
}

export default function SmsTemplates() {
    const { data: rawSettings, error: loadError, callReq } = useApi('setting/read')
    const { domains = [] } = useLists() || {}
    const { isSuperAdmin, role } = useUser() || {}
    const { TR } = useText() || {}
    const t = (key, params) => TR?.(key, params) || key
    const [domainId, setDomainId] = useState('')
    const [selectedKey, setSelectedKey] = useState(ORDER_SMS_TEMPLATE_KEYS.delivery.paid)
    const [templates, setTemplates] = useState({})
    const [originals, setOriginals] = useState({})
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState(null)
    const [message, setMessage] = useState(null)
    const textareaRefs = useRef({})

    const canEdit = isSuperAdmin || role?.permissions?.includes('setting:update')
    const loaded = Array.isArray(rawSettings)
    const settings = useMemo(() => loaded ? rawSettings : [], [loaded, rawSettings])

    useEffect(() => {
        if (!domainId && domains.length) {
            const def = domains.find(domain => domain?.isDefault)
            const first = def ?? domains[0]
            setDomainId(first?.value ?? first ?? '')
        }
    }, [domains, domainId])

    const domainSettings = useMemo(() => settings.filter(setting =>
        setting.domainId === domainId
        && setting.category === ORDER_SMS_CATEGORY
        && setting.subCategory === ORDER_SMS_SUB_CATEGORY
    ), [settings, domainId])

    useEffect(() => {
        const next = buildTemplates(domainSettings)
        setTemplates(next.templates)
        setOriginals(next.originals)
        setError(null)
    }, [domainId, domainSettings])

    const byKey = useMemo(
        () => Object.fromEntries(domainSettings.map(setting => [setting.key, setting])),
        [domainSettings]
    )

    const keys = useMemo(() => ORDER_SMS_METHODS.flatMap(method =>
        ORDER_SMS_STAGES.map(stage => ORDER_SMS_TEMPLATE_KEYS[method.key][stage.key])
    ), [])

    const changedKeys = keys.filter(key => templates[key] !== originals[key])
    const dirty = changedKeys.length > 0

    const selectedMethod = ORDER_SMS_METHODS.find(method =>
        Object.values(ORDER_SMS_TEMPLATE_KEYS[method.key]).includes(selectedKey)
    )
    const selectedStage = selectedMethod
        ? ORDER_SMS_STAGES.find(stage => ORDER_SMS_TEMPLATE_KEYS[selectedMethod.key][stage.key] === selectedKey)
        : null
    const selectedValue = templates[selectedKey] ?? ''

    function updateTemplate(key, value) {
        setTemplates(prev => ({ ...prev, [key]: value }))
        setMessage(null)
    }

    function insertVariable(key, variableKey) {
        const token = `{{${variableKey}}}`
        const element = textareaRefs.current[key]
        const current = templates[key] || ''
        const start = element?.selectionStart ?? current.length
        const end = element?.selectionEnd ?? current.length
        updateTemplate(key, `${current.slice(0, start)}${token}${current.slice(end)}`)
        requestAnimationFrame(() => {
            if (!element) return
            element.focus()
            element.setSelectionRange(start + token.length, start + token.length)
        })
    }

    async function handleSave() {
        if (!domainId || !loaded || !canEdit || !dirty) return
        setSaving(true)
        setError(null)
        setMessage(null)
        try {
            const requests = []
            for (const key of keys) {
                const value = templates[key] ?? ''
                const existing = byKey[key]
                if (existing) {
                    if (existing.value !== value || !existing.hidden)
                        requests.push(apiReq('setting/update', { id: existing.id, value, hidden: true }))
                    continue
                }
                requests.push(apiReq('setting/create', {
                    key,
                    value,
                    domainId,
                    category: ORDER_SMS_CATEGORY,
                    subCategory: ORDER_SMS_SUB_CATEGORY,
                    formType: 'textarea',
                    renderType: 'string',
                    public: false,
                    hidden: true
                }))
            }
            await Promise.all(requests)
            await callReq()
            setMessage(!requests.length
                ? t('order_sms_no_changes')
                : requests.length === 1
                    ? t('order_sms_saved_one')
                    : t('order_sms_saved', { count: requests.length }))
        } catch (err) {
            setError(err?.message || t('order_sms_save_failed'))
        } finally {
            setSaving(false)
        }
    }

    return <div className={styles.page}>
        <div className={styles.header}>
            <div>
                <Text size="h2" tag="h1" bold>{t('order_sms_title')}</Text>
                <Text className={styles.muted}>{t('order_sms_subtitle')}</Text>
            </div>
            <div className={styles.actions}>
                <Select
                    options="domains"
                    value={domainId}
                    onChange={event => {
                        setDomainId(event.target.value)
                        setMessage(null)
                        setError(null)
                    }}
                    className={styles.domainSelect}
                />
            </div>
        </div>

        {(error || loadError) && <div className={styles.error}>{error || loadError?.message || t('order_sms_load_failed')}</div>}
        {message && <div className={styles.message}>{message}</div>}
        {!canEdit && <div className={styles.notice}>{t('order_sms_view_only_notice')}</div>}

        <div className={styles.layout}>
            <nav className={styles.sidebar}>
                <div className={styles.sidebarHeader}>{t('order_sms_sidebar_title')}</div>
                {ORDER_SMS_METHODS.map(method => <div key={method.key} className={styles.sidebarGroup}>
                    <div className={styles.groupTitle}>{t(`order_sms_method_${method.key}`)}</div>
                    {ORDER_SMS_STAGES.map(stage => {
                        const key = ORDER_SMS_TEMPLATE_KEYS[method.key][stage.key]
                        const changed = templates[key] !== originals[key]
                        return <button
                            key={key}
                            type="button"
                            className={`${styles.sidebarItem} ${selectedKey === key ? styles.sidebarItemActive : ''}`}
                            onClick={() => setSelectedKey(key)}
                        >
                            <span>{t(stageTitleKey(method, stage))}</span>
                            {changed && <span className={styles.unsavedDot} title={t('order_sms_unsaved')} />}
                        </button>
                    })}
                </div>)}
            </nav>

            <section className={styles.editor}>
                {selectedMethod && selectedStage ? <>
                    <div className={styles.editorHeader}>
                        <div>
                            <Text size="l" bold>{t(stageTitleKey(selectedMethod, selectedStage))}</Text>
                            <Text size="s" className={styles.muted}>{t(stageDescriptionKey(selectedStage))}</Text>
                        </div>
                        <Text size="xs" className={styles.muted}>{selectedKey}</Text>
                    </div>

                    <textarea
                        ref={element => { textareaRefs.current[selectedKey] = element }}
                        className={styles.textarea}
                        dir="rtl"
                        rows={8}
                        value={selectedValue}
                        disabled={!canEdit}
                        onChange={event => updateTemplate(selectedKey, event.target.value)}
                    />

                    <div className={styles.variables}>
                        {ORDER_SMS_VARIABLES.map(variable => {
                            if (variable.key === 'pickup_store_name' && selectedMethod.key !== 'pickup') return null
                            return <button
                                key={variable.key}
                                type="button"
                                className={styles.variable}
                                title={t(`order_sms_var_${variable.key}`)}
                                disabled={!canEdit}
                                onClick={() => insertVariable(selectedKey, variable.key)}
                            >{`{{${variable.key}}}`}</button>
                        })}
                    </div>

                    <div className={styles.preview}>
                        <Text size="xs" className={styles.muted}>{t('order_sms_preview')}</Text>
                        <div className={styles.previewBody} dir="rtl">
                            <bdi dir="rtl">{renderOrderSmsTemplate(selectedValue, SAMPLE_VALUES) || '—'}</bdi>
                        </div>
                    </div>

                    <div className={styles.editorFooter}>
                        <Button
                            onClick={handleSave}
                            loading={saving}
                            disabled={!loaded || !canEdit || !dirty}
                            tooltip={!canEdit ? t('order_sms_save_permission') : undefined}
                        >
                            {t('order_sms_save')}
                        </Button>
                    </div>
                </> : <Text className={styles.muted}>{t('order_sms_select_template')}</Text>}
            </section>
        </div>
    </div>
}
