import diff from '#common/functions/diff.js'

function normalizeEntry(raw, targetDomainId, defaultDomainId) {
    if (!raw || typeof raw !== 'object') return null
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    // ponytail: explicit target (domain picker) wins so files move between
    // domains; otherwise fall back to the entry's own domain for old files,
    // then to the default domain. No magic 'default' id.
    const domainId = targetDomainId
        || (typeof raw.domainId === 'string' && raw.domainId ? raw.domainId : defaultDomainId)
    if (!key) return null
    const entry = {
        key,
        value: raw.value,
        category: typeof raw.category === 'string' && raw.category ? raw.category.toLowerCase() : 'general',
        subCategory: typeof raw.subCategory === 'string' && raw.subCategory ? raw.subCategory.toLowerCase() : 'general',
        domainId,
        formType: raw.formType || 'text',
        renderType: raw.renderType || 'string',
        public: !!raw.public
    }
    if (typeof raw.hidden === 'boolean') entry.hidden = raw.hidden
    return entry
}

export default async function imp(payload, { DL, _admin }) {
    // Router permission arrays are OR; import performs both creates and
    // updates, so enforce strict AND here (no new permission = no role migration)
    if (!_admin?.hasPermission?.('setting:create') || !_admin?.hasPermission?.('setting:update'))
        throw { status: 403, message: 'Forbidden' }

    // Accept the export envelope or a bare array
    const rawList = Array.isArray(payload?.settings)
        ? payload.settings
        : Array.isArray(payload?.data)
            ? payload.data
            : Array.isArray(payload)
                ? payload
                : null
    if (!rawList)
        throw { status: 400, message: 'missing settings array' }
    if (rawList.length > 2000)
        throw { status: 400, message: 'import limited to 2000 settings per file' }

    const isSuperAdmin = !!_admin?.isSuperAdmin
    // Target domain (domain picker) overrides per-entry domains; bare-array
    // payloads without one keep their own domain for backward compat
    const targetDomainId = !Array.isArray(payload) && typeof payload?.domainId === 'string' && payload.domainId
        ? payload.domainId
        : null
    if (targetDomainId) {
        const domain = await DL.Domain.readById(targetDomainId)
        if (!domain) throw { status: 400, message: `invalid domain id "${targetDomainId}"` }
    }
    // Default-domain fallback for entries without their own domain
    let defaultDomainId = null
    if (!targetDomainId && rawList.some(raw => !(typeof raw?.domainId === 'string' && raw.domainId))) {
        const def = await DL.Domain.readOne({ isDefault: true, active: true }, { _id: 0, id: 1 })
        if (!def?.id) throw { status: 500, message: 'no default domain configured' }
        defaultDomainId = def.id
    }
    // Last occurrence of a (domainId + key) pair wins
    const byScopeKey = new Map()
    for (const raw of rawList) {
        const entry = normalizeEntry(raw, targetDomainId, defaultDomainId)
        if (!entry) continue
        byScopeKey.set(`${entry.domainId}::${entry.key}`, entry)
    }
    if (byScopeKey.size === 0)
        throw { status: 400, message: 'no valid settings in file' }

    let created = 0
    let updated = 0
    const errors = []
    const skippedConfig = []

    for (const entry of byScopeKey.values()) {
        try {
            const isConfig = entry.formType === 'config' || entry.renderType === 'config'
            if (isConfig && !isSuperAdmin) {
                skippedConfig.push(entry.key)
                continue
            }
            if (entry.value === undefined)
                throw { status: 400, message: `missing value for "${entry.key}"` }

            const existing = await DL.Setting.readOne({ domainId: entry.domainId, key: entry.key })
            if (!existing) {
                const domain = await DL.Domain.readById(entry.domainId)
                if (!domain) throw { status: 400, message: `invalid domain id "${entry.domainId}"` }
                await DL.Setting.create(entry)
                created++
            } else {
                // DL wrappers re-encrypt config values on write automatically
                const update = diff(existing, { ...existing, ...entry })
                delete update.key
                delete update.domainId
                delete update.id
                if (Object.keys(update).length === 0) continue
                await DL.Setting.updateOne({ id: existing.id }, update)
                updated++
            }
        } catch (e) {
            errors.push({ key: entry?.key, message: e?.message || 'failed' })
        }
    }

    return { created, updated, skippedConfig, errors, domainId: targetDomainId }
}

imp.config = {
    required: [],
    permissions: ['setting:create', 'setting:update']
}
