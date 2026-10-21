import { useState, useMemo, useEffect, useRef } from 'react'
import { useModal } from 'common/components/Modal'
import { useLists } from 'common/features/Lists'
import { useUser } from 'features/User'
import Button from 'common/components/Button'
import useApi from 'common/functions/useApi'
import apiReq from 'common/functions/apiReq'
import Input from 'common/components/Input'
import Select from 'common/components/Select'
import styles from './settings.module.css'
import Checkbox from 'common/components/Checkbox'
import Card from 'common/components/Card'
import Flex from 'common/components/Flex'
import Setting from './Setting.jsx'
import ConfigEditor from './ConfigEditor.jsx'
import { getSettingFileUrl } from 'common/functions/settingFileUrl'

const FORM_TYPES = [
    'text', 'checkbox', 'switch', 'color', 'select',
    'file', 'image', 'textarea', 'date', 'info', 'link', 'css', 'config'
]

const RENDER_TYPES = [
    'string', 'tr', 'image', 'color', 'list', 'field', 'name', 'id',
    'address', 'date', 'time', 'datetime', 'boolean', 'v-boolean',
    'color-boolean', 'nis', 'coin', 'mr', 'config'
]

function SettingModalContent({ setting, defaultCategory, defaultSubCategory, defaultDomainId, defaultFormType, defaultRenderType, onSuccess, onClose }) {
    const isEdit = !!setting
    const { isSuperAdmin: modalIsSuperAdmin, role } = useUser() || {}
    const initialIsConfig = setting?.formType === 'config' || setting?.renderType === 'config' || defaultFormType === 'config' || defaultRenderType === 'config'
    const [formData, setFormData] = useState({
        key: setting?.key || '',
        value: setting?.value !== undefined ? setting.value : (initialIsConfig ? {} : ''),
        category: setting?.category || defaultCategory || 'General',
        subCategory: setting?.subCategory || defaultSubCategory || 'General',
        domainId: setting?.domainId || defaultDomainId || '',
        formType: setting?.formType || defaultFormType || 'text',
        renderType: setting?.renderType || defaultRenderType || 'string',
        public: setting?.public ?? false
    })
    const [error, setError] = useState(null)
    const [loading, setLoading] = useState(false)
    const [pendingFile, setPendingFile] = useState(null)
    const [modalUploading, setModalUploading] = useState(false)
    const modalFileRef = useRef(null)

    const isModalFileType = formData.formType === 'file' || formData.formType === 'image' || formData.renderType === 'image'
    const isModalImage = formData.formType === 'image' || formData.renderType === 'image'

    function handleModalFile(e) {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        setError(null)
        if (isModalImage && !/^(image\/|.*\.(svg|ico)$)/i.test(`${file.type} ${file.name}`)) {
            setError('Only image files (png/jpg/webp/svg/ico)')
            return
        }
        if (!isModalImage && !/^(application\/pdf|.*\.pdf)$/i.test(`${file.type} ${file.name}`)) {
            setError('Only PDF files')
            return
        }
        if (file.size > 8 * 1024 * 1024) {
            setError('File too large (max 8MB)')
            return
        }
        const reader = new FileReader()
        reader.onload = async () => {
            const dataUrl = String(reader.result || '')
            const fileBase64 = dataUrl.includes(',') ? dataUrl.split(',').pop() : dataUrl
            if (isEdit) {
                setModalUploading(true)
                try {
                    const res = await apiReq('setting/upload_file', { id: setting.id, fileBase64, filename: file.name, contentType: file.type })
                    const next = res?.basePath || res?.setting?.value
                    if (!next) throw new Error('Upload failed')
                    setFormData((prev) => ({ ...prev, value: next }))
                } catch (err) {
                    setError(err?.message || 'Upload failed')
                } finally {
                    setModalUploading(false)
                }
            } else {
                setPendingFile({ fileBase64, filename: file.name, contentType: file.type })
            }
        }
        reader.readAsDataURL(file)
    }

    async function handleSubmit(e) {
        e.preventDefault()
        setLoading(true)
        setError(null)
        try {
            let result
            if (isEdit) {
                result = await apiReq('setting/update', { id: setting.id, ...formData })
            } else {
                const toCreate = pendingFile ? { ...formData, value: pendingFile.filename || 'pending upload' } : formData
                result = await apiReq('setting/create', toCreate)
                if (pendingFile && result?.id) {
                    const up = await apiReq('setting/upload_file', { id: result.id, ...pendingFile })
                    result = up?.setting || { ...result, value: up?.basePath }
                }
            }
            onSuccess(result || { ...(setting || {}), ...formData })
            onClose()
        } catch (err) {
            setError(err?.message || `Failed to ${isEdit ? 'update' : 'create'} setting`)
        } finally {
            setLoading(false)
        }
    }

    const isConfig = formData.formType === 'config' || formData.renderType === 'config'
    const isColor = formData.formType === 'color'
    const canAddConfig = !!modalIsSuperAdmin
    // filter 'config' for users who cannot add configs; keep current value if already config to avoid blank select
    const formTypeOptions = canAddConfig ? FORM_TYPES : FORM_TYPES.filter((t) => t !== 'config' || t === formData.formType)
    const renderTypeOptions = canAddConfig ? RENDER_TYPES : RENDER_TYPES.filter((t) => t !== 'config' || t === formData.renderType)

    function normalizeColorValue(val) {
        if (val && typeof val === 'object' && ('light' in val || 'dark' in val)) return val
        if (typeof val === 'string' && val) return { light: val, dark: val }
        return { light: '#000000', dark: '#ffffff' }
    }

    return (
        <form onSubmit={handleSubmit} className={styles.modalForm}>
            <Input
                label="Key"
                name="key"
                required
                value={formData.key}
                onChange={(e) => setFormData({ ...formData, key: e.target.value })}
                disabled={isEdit && !modalIsSuperAdmin}
                title={isEdit && !modalIsSuperAdmin ? 'Only superAdmin can edit keys' : undefined}
            />
            <div className={styles.formGrid}>
                <label className={styles.settingInfo}>
                    <span className={styles.settingKey}>Form Type</span>
                    <Select
                        value={formData.formType}
                        onChange={(e) => setFormData({ ...formData, formType: e.target.value })}
                        options={formTypeOptions}
                    />
                </label>
                <label className={styles.settingInfo}>
                    <span className={styles.settingKey}>Render Type</span>
                    <Select
                        value={formData.renderType}
                        onChange={(e) => setFormData({ ...formData, renderType: e.target.value })}
                        options={renderTypeOptions}
                    />
                </label>
            </div>
            <div className={styles.formGrid}>
                <Input
                    label="Category"
                    name="category"
                    required
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                />
                <Input
                    label="Sub Category"
                    name="subCategory"
                    required
                    value={formData.subCategory}
                    onChange={(e) => setFormData({ ...formData, subCategory: e.target.value })}
                />
            </div>
            <label className={styles.settingInfo}>
                <span className={styles.settingKey}>Domain *</span>
                <Select
                    options="domains"
                    value={formData.domainId}
                    onChange={(e) => setFormData({ ...formData, domainId: e.target.value })}
                    required
                    name="domainId"
                />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <Checkbox checked={!!formData.public} onChange={(e) => setFormData({ ...formData, public: e.target.checked })} />
                <span className={styles.settingKey} title="If enabled, this setting is sent to the client (getSettings)">Public — sent to client</span>
            </label>
            {isConfig ? (
                <div>
                    <span className={styles.settingKey}>Value (config) {!modalIsSuperAdmin && <em style={{ fontWeight: 400, fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>(keys view-only)</em>}</span>
                    <ConfigEditor
                        value={typeof formData.value === 'object' && formData.value !== null && !Array.isArray(formData.value) ? formData.value : {}}
                        onChange={(next) => setFormData({ ...formData, value: next })}
                        canEditKeys={!!modalIsSuperAdmin}
                        canEditValues={role.permissions?.includes('setting:update')}
                    />
                </div>
            ) : isColor ? (
                <div className={styles.formGrid}>
                    <label className={styles.settingInfo}>
                        <span className={styles.settingKey}>Light</span>
                        <input type="color" className={styles.inlineColorInput} value={normalizeColorValue(formData.value).light} onChange={(e) => setFormData({ ...formData, value: { ...normalizeColorValue(formData.value), light: e.target.value } })} />
                    </label>
                    <label className={styles.settingInfo}>
                        <span className={styles.settingKey}>Dark</span>
                        <input type="color" className={styles.inlineColorInput} value={normalizeColorValue(formData.value).dark} onChange={(e) => setFormData({ ...formData, value: { ...normalizeColorValue(formData.value), dark: e.target.value } })} />
                    </label>
                </div>
            ) : isModalFileType ? (
                <div>
                    <span className={styles.settingKey}>Value ({isModalImage ? 'image: png/jpg/webp/svg/ico' : 'PDF only'})</span>
                    {typeof formData.value === 'string' && formData.value && !pendingFile && (
                        <div style={{ margin: '0.35rem 0' }}>
                            {isModalImage
                                ? <img src={getSettingFileUrl(formData.value)} alt="" className={styles.settingThumb} style={{ maxHeight: '4rem', maxWidth: '10rem' }} />
                                : <a href={getSettingFileUrl(formData.value)} target="_blank" rel="noreferrer" className={styles.linkValue}>Open current file</a>}
                        </div>
                    )}
                    {pendingFile && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0.25rem 0' }}>Selected: {pendingFile.filename} (uploads on Add)</div>}
                    <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        <Button type="button" icon="upload" disabled={loading || modalUploading} loading={modalUploading} onClick={() => modalFileRef.current?.click()}>
                            {isEdit ? 'Upload file' : 'Choose file'}
                        </Button>
                        <input
                            ref={modalFileRef}
                            type="file"
                            accept={isModalImage ? 'image/png,image/jpeg,image/webp,.svg,.ico' : 'application/pdf,.pdf'}
                            onChange={handleModalFile}
                            disabled={loading || modalUploading}
                            style={{ display: 'none' }}
                        />
                    </div>
                </div>
            ) : (
                <Input
                    label="Value"
                    name="value"
                    required
                    value={typeof formData.value === 'object' ? JSON.stringify(formData.value) : formData.value ?? ''}
                    onChange={(e) => setFormData({ ...formData, value: e.target.value })}
                />
            )}
            {error && (
                <div className={styles.settingError}>{error}</div>
            )}

            <div className={styles.modalActions}>
                <Button
                    onClick={onClose}
                    disabled={loading}
                >
                    Cancel
                </Button>
                <Button type="submit" disabled={loading}>
                    {loading ? 'saving' : isEdit ? 'Save' : 'Add'}
                </Button>
            </div>
        </form>
    )
}

const EMPTY_DOMAINS = []

export default function Settings() {
    const { data: rawSettings, callReq, loading } = useApi('setting/read')
    const [settings, setSettings] = useState([])
    const rawRef = useRef()
    const [selectedDomain, setSelectedDomain] = useState(null)
    const [selectedCategory, setSelectedCategory] = useState(null)
    const [mobileView, setMobileView] = useState('sidebar') // 'sidebar' or 'content'
    const { openModal, closeModal } = useModal()
    const { isSuperAdmin, role: adminRole } = useUser()
    const { domains = EMPTY_DOMAINS } = useLists() || {}
    // Default the working domain to the isDefault domain (first domain as fallback)
    useEffect(() => {
        if (!selectedDomain && domains.length) {
            const def = domains.find((d) => d?.isDefault)
            const first = def ?? domains[0]
            setSelectedDomain(first?.value ?? first)
        }
    }, [domains, selectedDomain])
    const selectedDomainName = useMemo(() => {
        const found = domains.find((d) => (d?.value ?? d) === selectedDomain)
        return found?.text || found?.name || selectedDomain
    }, [domains, selectedDomain])
    function domainNameOf(id) {
        const found = domains.find((d) => (d?.value ?? d) === id)
        return found?.text || found?.name || id
    }
    const canDeleteSetting = isSuperAdmin || adminRole?.permissions?.includes('setting:delete')
    const canCreateSetting = isSuperAdmin || adminRole?.permissions?.includes('setting:create')
    const canUpdateSetting = isSuperAdmin || adminRole?.permissions?.includes('setting:update')
    // Strict AND: import does both creates and updates, mirroring server permissions
    const canImport = isSuperAdmin || (canCreateSetting && canUpdateSetting)
    const fileInputRef = useRef(null)

    useEffect(() => {
        if (Array.isArray(rawSettings) && rawRef.current !== rawSettings) {
            rawRef.current = rawSettings
            setSettings(rawSettings)
        }
    }, [rawSettings])

    // Work one domain at a time — export/import/add scope to selectedDomain
    const domainSettings = useMemo(() => {
        if (!selectedDomain) return []
        return settings.filter((s) => s.domainId === selectedDomain && !s.hidden)
    }, [settings, selectedDomain])

    // Extract unique categories & their item counts
    const categoryMap = useMemo(() => {
        const map = new Map()
        domainSettings.forEach((s) => {
            const cat = s.category || 'General'
            if (!map.has(cat)) {
                map.set(cat, [])
            }
            map.get(cat).push(s)
        })
        return map
    }, [domainSettings])

    const categories = useMemo(() => Array.from(categoryMap.keys()), [categoryMap])

    // Select first category by default; reset when switching domains
    useEffect(() => {
        if (!categories.includes(selectedCategory)) {
            setSelectedCategory(categories.length > 0 ? categories[0] : null)
        }
    }, [categories, selectedCategory])

    function handleSelectCategory(cat) {
        setSelectedCategory(cat)
        setMobileView('content')
    }

    function handleSettingUpdate(updatedSetting) {
        setSettings((prev) =>
            prev.map((s) => (s.id === updatedSetting.id ? { ...s, ...updatedSetting } : s))
        )
    }

    function handleDelete(id) {
        setSettings((prev) => prev.filter((s) => s.id !== id))
    }

    function handleAddModal(defaultCat = '', defaultSubCat = '', defaultFormType, defaultRenderType) {
        const targetCategory = defaultCat || selectedCategory || 'General'
        const targetSubCategory = defaultSubCat || 'General'
        const targetFormType = defaultFormType || 'text'
        const targetRenderType = defaultRenderType || 'string'
        const isConfigAdd = targetFormType === 'config' || targetRenderType === 'config'
        if (isConfigAdd && !isSuperAdmin) return
        if (!isConfigAdd && !canCreateSetting) return
        openModal(
            <SettingModalContent
                defaultCategory={targetCategory}
                defaultSubCategory={targetSubCategory}
                defaultDomainId={selectedDomain || ''}
                defaultFormType={targetFormType}
                defaultRenderType={targetRenderType}
                onClose={closeModal}
                onSuccess={(created) => {
                    callReq()
                    if (created) {
                        if (created.domainId && created.domainId !== selectedDomain) {
                            setSelectedDomain(created.domainId)
                        }
                        setSettings((prev) => [...prev, created])
                        if (created.category) {
                            setSelectedCategory(created.category)
                        }
                    }
                }}
            />,
            { title: 'Add New Setting' }
        )
    }

    function scopeFileName(scope = {}) {
        const date = new Date().toISOString().slice(0, 10)
        const parts = ['settings', scope.domainId || null, scope.category, scope.subCategory].filter(Boolean)
            .map((p) => String(p).replace(/[^\w-]+/g, '-'))
        return `${parts.join('-') || 'settings'}-${date}.json`
    }

    async function handleExport(scope = {}) {
        if (!selectedDomain) return
        const data = await apiReq('setting/export', { domainId: selectedDomain, ...scope })
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = scopeFileName(data?.scope || scope)
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    function handleImportClick() {
        fileInputRef.current?.click()
    }

    async function handleImportFile(e) {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        let parsed
        try {
            parsed = JSON.parse(await file.text())
        } catch {
            openModal(<div>Invalid JSON file — expected a settings export (.json).</div>, { title: 'Import failed' })
            return
        }
        const list = Array.isArray(parsed?.settings) ? parsed.settings : Array.isArray(parsed) ? parsed : null
        if (!list) {
            openModal(<div>Invalid file format — expected a settings export file.</div>, { title: 'Import failed' })
            return
        }
        try {
            const targetDomain = selectedDomain
            if (!targetDomain) {
                openModal(<div>No domain selected.</div>, { title: 'Import failed' })
                return
            }
            const res = await apiReq('setting/import', { settings: list, domainId: targetDomain })
            callReq()
            const lines = [`Domain: ${domainNameOf(res.domainId || targetDomain)}`, `Created: ${res.created}`, `Updated: ${res.updated}`]
            if (res.skippedConfig?.length) lines.push(`Skipped config (superAdmin only): ${res.skippedConfig.join(', ')}`)
            if (res.errors?.length) lines.push(`Errors: ${res.errors.map((x) => `${x.key}: ${x.message}`).join('; ')}`)
            openModal(<div style={{ whiteSpace: 'pre-wrap' }}>{lines.join('\n')}</div>, { title: `Import complete (${domainNameOf(res.domainId || targetDomain)})` })
        } catch (err) {
            openModal(<div>{err?.message || 'Import failed'}</div>, { title: 'Import failed' })
        }
    }

    function handleEditModal(settingToEdit) {        openModal(
            <SettingModalContent
                setting={settingToEdit}
                onClose={closeModal}
                onSuccess={(updated) => {
                    callReq()
                    handleSettingUpdate(updated)
                }}
            />,
            { title: `Edit Setting (${settingToEdit.key})` }
        )
    }

    // Settings for current active category grouped by subCategory
    const activeCategorySettings = useMemo(() => {
        if (!selectedCategory) return {}
        const list = categoryMap.get(selectedCategory) || []
        const grouped = {}
        list.forEach((setting) => {
            const sub = setting.subCategory || 'General'
            if (!grouped[sub]) {
                grouped[sub] = []
            }
            grouped[sub].push(setting)
        })
        return grouped
    }, [selectedCategory, categoryMap])

    return (
        <Flex tag={Card} className={`${styles.settingsContainer} ${styles[mobileView]}`}>
            {/* Category Sidebar List (Not a tree, based on category schema) */}
            <div className={styles.categoriesSidebar}>
                <div className={styles.sidebarHeaderRow}>
                    <h3 className={styles.sidebarHeader}>Settings</h3>
                    <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                        <Button size="s" icon="download" onClick={() => handleExport({})} title={`Export all settings (${selectedDomainName})`} tooltip={`Export all settings (${selectedDomainName})`} />
                        {canImport && <Button size="s" icon="upload" onClick={() => handleImportClick()} title={`Import into "${selectedDomainName}" (merge)`} tooltip={`Import into "${selectedDomainName}" (merge)`} />}
                        {canCreateSetting && <Button size="s" icon="add" onClick={() => handleAddModal()} title="Add Setting" />}
                    </span>
                </div>
                <div style={{ padding: '0 0.5rem 0.5rem' }}>
                    <Select
                        options="domains"
                        value={selectedDomain}
                        onChange={(e) => { setSelectedDomain(e.target.value); setMobileView('sidebar') }}
                        title="Working domain — list, export and new settings scope to it"
                        name="domainId"
                    />
                </div>
                <input ref={fileInputRef} type="file" accept=".json,application/json" onChange={handleImportFile} style={{ display: 'none' }} />

                <ul className={styles.categoryList}>
                    {categories.map((cat) => {
                        const count = categoryMap.get(cat)?.length || 0
                        const isActive = cat === selectedCategory
                        return (
                            <li
                                key={cat}
                                className={`${styles.categoryItem} ${isActive ? styles.active : ''}`}
                                onClick={() => handleSelectCategory(cat)}
                            >
                                <span>{cat}</span>
                                <span className={styles.categoryCount}>{count}</span>
                            </li>
                        )
                    })}
                </ul>
            </div>

            {/* Settings Body - iOS / Android Inset Grouping by subCategory */}
            <div className={styles.settingsBody}>
                <Button
                    className={styles.backButton}
                    icon="back"
                    onClick={() => setMobileView('sidebar')}
                >
                    Back to categories
                </Button>

                {selectedCategory ? (
                    <>
                        <div className={styles.categoryTitleRow}>
                            <h2 className={styles.categoryTitle}>{selectedCategory}</h2>
                            <span style={{ display: 'inline-flex', gap: '0.25rem' }}>
                                <Button size="s" icon="download" onClick={() => handleExport({ category: selectedCategory })} title={`Export "${selectedCategory}" (${selectedDomainName})`} tooltip={`Export "${selectedCategory}" (${selectedDomainName})`} />
{canImport && <Button size="s" icon="upload" onClick={() => handleImportClick()} title={`Import into "${selectedDomainName}" (merge)`} tooltip={`Import into "${selectedDomainName}" (merge)`} />}
                            </span>
                        </div>

                        {Object.keys(activeCategorySettings).length === 0 ? (
                            <div className={styles.emptyState}>No settings in this category</div>
                        ) : (
                            <div className={styles.sectionsList}>
                                {Object.entries(activeCategorySettings).map(([subCat, subCatSettings]) => {
                                    const last = subCatSettings[subCatSettings.length - 1]
                                    const isConfigGroup = last?.formType === 'config' || last?.renderType === 'config'
                                    const canAddHere = isConfigGroup ? isSuperAdmin : canCreateSetting
                                    return (
                                        <div key={subCat} className={styles.subCategoryGroup}>
                                            <div className={styles.subCategoryHeaderRow}>
                                                <h4 className={styles.subCategoryHeader}>{subCat}</h4>
                                                <Button icon="download" className={styles.subCategoryAddBtn} onClick={() => handleExport({ category: selectedCategory, subCategory: subCat })} title={`Export "${subCat}" (${selectedDomainName})`} tooltip={`Export "${subCat}" (${selectedDomainName})`} />
                                                {canImport && <Button icon="upload" className={styles.subCategoryAddBtn} onClick={() => handleImportClick()} title={`Import into "${selectedDomainName}" (merge)`} tooltip={`Import into "${selectedDomainName}" (merge)`} />}
                                                {canAddHere && <Button icon="add" className={styles.subCategoryAddBtn} onClick={() => handleAddModal(selectedCategory, subCat, last?.formType, last?.renderType)} title={isConfigGroup ? 'Add config (superAdmin only)' : `Add setting to ${subCat}`} />}
                                            </div>
                                            <div className={styles.insetGroupCard}>
                                                {subCatSettings.map((setting) => (
                                                    <Setting
                                                        key={setting.id || setting.key}
                                                        setting={setting}
                                                        onUpdate={handleSettingUpdate}
                                                        onEditFull={handleEditModal}
                                                        onDelete={canDeleteSetting ? handleDelete : undefined}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </>
                ) : loading ? (
                    <div className={styles.emptyState}>Loading settings...</div>
                ) : (
                    <div className={styles.emptyState} style={{ flexDirection: 'column', gap: '1rem' }}>
                        <span>No settings yet</span>
                        {canCreateSetting && <Button icon="add" onClick={() => handleAddModal()}>Add Setting</Button>}
                    </div>
                )}
            </div>
        </Flex>
    )
}
