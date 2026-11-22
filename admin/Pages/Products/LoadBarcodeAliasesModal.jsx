import { useRef, useState } from 'react'
import apiReq from 'common/functions/apiReq'
import Button from 'common/components/Button'
import Flex from 'common/components/Flex'
import Text from 'common/components/Text'
import { useText } from 'common/texts/TextProvider'
import styles from './bulkLoad.module.css'

const MAX_CSV_CHARS = 2000000
const LIST_LIMIT = 50

function Stat({ label, value, TR }) {
    if (value == null) return null
    return <Flex gap={8} alignItems='center'>
        <Text size='s' mode='sub'>{TR(label)}</Text>
        <Text size='s' bold>{value}</Text>
    </Flex>
}

function Blocker({ blocker, TR }) {
    const detail = [
        blocker.barcode,
        blocker.owner ? `→ ${blocker.owner}` : '',
        blocker.value || '',
        blocker.lines ? `(${blocker.lines.join(', ')})` : ''
    ].filter(Boolean).join(' ')
    return <Text size='s' mode='sub'>
        {TR(`barcode_alias_reason_${blocker.reason}`)}{detail ? ` — ${detail}` : ''}
    </Text>
}

function PlanList({ plans, TR }) {
    if (!plans?.length) return null
    return <Flex col gap={4} className={styles.list}>
        <Text size='s' bold>{TR('barcode_alias_rows_detail')} ({plans.length})</Text>
        {plans.slice(0, LIST_LIMIT).map(plan =>
            <Flex key={plan.line} col gap={2}>
                <Text size='s' className={styles.listRow}>
                    {plan.mainBarcode}
                    {plan.mainName ? ` — ${plan.mainName}` : ''}
                    {' · '}{TR('barcode_alias_row_aliases', { count: plan.aliases.length })}
                    {plan.aliasesRemoved?.length
                        ? ` · ${TR('barcode_alias_row_removed', { count: plan.aliasesRemoved.length, barcodes: plan.aliasesRemoved.join(', ') })}` : ''}
                    {plan.duplicates.length ? ` · ${TR('barcode_alias_row_duplicates', { count: plan.duplicates.length })}` : ''}
                    {plan.salesBefore !== plan.salesAfter
                        ? ` · ${TR('barcode_alias_row_sales', { before: plan.salesBefore, after: plan.salesAfter })}` : ''}
                    {plan.labelBefore && !plan.labelAfter
                        ? ` · ${TR('barcode_alias_row_label_removed')}` : ''}
                    {plan.statusBefore && plan.statusAfter && plan.statusBefore !== plan.statusAfter
                        ? ` · ${plan.statusBefore} → ${plan.statusAfter}` : ''}
                </Text>
                {plan.blockers.map((blocker, i) => <Blocker key={i} blocker={blocker} TR={TR} />)}
            </Flex>)}
        {plans.length > LIST_LIMIT
            && <Text size='s' mode='sub'>{TR('barcode_alias_more', { count: plans.length - LIST_LIMIT })}</Text>}
    </Flex>
}

function ErrorList({ errors, TR }) {
    if (!errors?.length) return null
    return <Flex col gap={4} className={styles.list}>
        <Text size='s' bold>{TR('barcode_alias_errors')} ({errors.length})</Text>
        {errors.slice(0, LIST_LIMIT).map((error, i) =>
            <Text key={i} size='s' className={styles.listRow}>
                {TR('barcode_alias_line', { line: error.line })}
                {error.mainBarcode ? ` — ${error.mainBarcode}` : ''}
                {' · '}{TR(`barcode_alias_reason_${error.reason}`)}
            </Text>)}
        {errors.length > LIST_LIMIT
            && <Text size='s' mode='sub'>{TR('barcode_alias_more', { count: errors.length - LIST_LIMIT })}</Text>}
    </Flex>
}

/**
 * ייבוא שיוך ברקודים — attach secondary barcodes to products from a CSV.
 *
 * Same two steps as the other bulk loads: the check pass plans every row and
 * writes nothing; the apply pass runs the plan for the rows that are clean.
 * The server owns parsing, duplicate detection, the deleted_products snapshot,
 * the guest-cart rewrite and the family write
 * (server/services/barcodeAliases/index.js) — this modal only carries the file
 * and renders the report.
 */
export default function LoadBarcodeAliasesModal({ onDone }) {
    const { TR } = useText()
    const fileRef = useRef(null)
    const [file, setFile] = useState(null)
    const [report, setReport] = useState(null)
    const [applied, setApplied] = useState(false)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState(null)

    function reset() {
        setReport(null)
        setApplied(false)
        setError(null)
    }

    function handleFile(e) {
        const picked = e.target.files?.[0]
        e.target.value = ''
        if (!picked) return
        setFile(null)
        reset()
        if (!/\.csv$|text\/csv/i.test(`${picked.name} ${picked.type}`)) {
            setError('barcode_alias_not_csv')
            return
        }
        const reader = new FileReader()
        reader.onload = () => {
            const csv = String(reader.result || '')
            if (csv.length > MAX_CSV_CHARS) {
                setError('barcode_alias_file_too_large')
                return
            }
            setFile({ name: picked.name, csv })
        }
        reader.onerror = () => setError('barcode_alias_not_csv')
        reader.readAsText(picked)
    }

    async function run(dryRun) {
        if (!file?.csv) {
            setError('barcode_alias_no_file')
            return
        }
        setError(null)
        setBusy(true)
        try {
            const res = await apiReq('product/import_barcode_aliases', { csv: file.csv, dryRun })
            setReport(res)
            setApplied(!dryRun)
            if (!dryRun) onDone?.()
        } catch (err) {
            setError(err?.message || String(err))
        } finally {
            setBusy(false)
        }
    }

    const stats = report?.stats
    const appliedReport = report?.applied
    const canApply = !!report && !applied && !busy && (stats?.applicable || 0) > 0

    return <Flex col gap={14}>
        <Text size='s' mode='sub'>{TR('barcode_alias_hint')}</Text>
        <Text size='s' mode='sub'>{TR('barcode_alias_columns')}</Text>

        <Flex gap={10} alignItems='center'>
            <input
                ref={fileRef}
                type='file'
                accept='.csv,text/csv'
                onChange={handleFile}
                style={{ display: 'none' }}
            />
            <Button
                type='button'
                mode='outline'
                icon='upload'
                disabled={busy}
                onClick={() => fileRef.current?.click()}
                text={TR('barcode_alias_file')}
            />
            {file && <Text size='s'>{file.name}</Text>}
        </Flex>

        {error && <Text size='s' mode='error'>{TR(error)}</Text>}

        <Flex gap={10}>
            <Button
                type='button'
                mode='outline'
                icon='search'
                disabled={!file || busy}
                onClick={() => run(true)}
                text={TR('barcode_alias_check')}
            />
            <Button
                type='button'
                icon='upload'
                disabled={!canApply}
                onClick={() => run(false)}
                text={TR('barcode_alias_apply')}
            />
        </Flex>

        {report && <Flex col gap={6} className={styles.report}>
            <Flex gap={16} wrap>
                <Stat TR={TR} label='barcode_alias_rows' value={stats?.rows} />
                <Stat TR={TR} label='barcode_alias_applicable' value={stats?.applicable} />
                <Stat TR={TR} label='barcode_alias_blocked' value={stats?.blocked} />
                <Stat TR={TR} label='barcode_alias_missing_main' value={stats?.missingMain} />
                <Stat TR={TR} label='barcode_alias_aliases' value={stats?.aliases} />
                <Stat TR={TR} label='barcode_alias_aliases_removed' value={stats?.aliasesRemoved} />
                <Stat TR={TR} label='barcode_alias_duplicates' value={stats?.duplicateDocs} />
                <Stat TR={TR} label='barcode_alias_parse_errors' value={stats?.parseErrors} />
            </Flex>

            {appliedReport && <Flex gap={16} wrap>
                <Stat TR={TR} label='barcode_alias_deleted' value={appliedReport.deleted} />
                <Stat TR={TR} label='barcode_alias_carts' value={appliedReport.cartsRewritten} />
            </Flex>}

            <Text size='s' mode='sub'>
                {TR(applied ? 'barcode_alias_applied_note' : 'barcode_alias_dry_note')}
            </Text>

            <PlanList plans={report.rows} TR={TR} />
            <ErrorList errors={report.errors} TR={TR} />
        </Flex>}
    </Flex>
}
