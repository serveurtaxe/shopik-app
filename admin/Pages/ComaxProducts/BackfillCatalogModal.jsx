import { useRef, useState } from 'react'
import apiReq from 'common/functions/apiReq'
import Button from 'common/components/Button'
import Flex from 'common/components/Flex'
import Loader from 'common/components/Loader'
import Text from 'common/components/Text'
import { useText } from 'common/texts/TextProvider'
import styles from './backfillCatalog.module.css'

const MAX_CSV_CHARS = 3000000
// Same bound the API uses: the lookups run in one request, so a full catalog is
// several runs and each one reports what is left.
const BATCH = 500
const LIST_LIMIT = 20

const COUNTS = [
    'codes', 'known', 'targets', 'processed', 'found',
    'inserted', 'refreshed', 'existing', 'archived', 'noPriceList', 'withBuyingPrice', 'zeroPrice', 'errorCount'
]
const SKIPS = ['notFound', 'noBarcode', 'idMismatch', 'duplicateBarcode']

function totalize(totals, report) {
    const next = { ...totals, skipped: { ...totals.skipped } }
    for (const key of COUNTS) next[key] = (next[key] || 0) + (report[key] || 0)
    for (const key of SKIPS) next.skipped[key] = (next.skipped[key] || 0) + (report.skipped?.[key] || 0)
    next.runs = (next.runs || 0) + 1
    next.gs1 = (next.gs1 || 0) + (report.gs1?.enqueued || 0)
    return next
}

function Stat({ label, value, TR }) {
    if (!value) return null
    return <Flex gap={8} alignItems='center'>
        <Text size='s' mode='sub'>{TR(label)}</Text>
        <Text size='s' bold>{value}</Text>
    </Flex>
}

function ItemList({ title, items, TR }) {
    if (!items?.length) return null
    return <Flex col gap={4} className={styles.list}>
        <Text size='s' bold>{TR(title)} ({items.length})</Text>
        {items.slice(0, LIST_LIMIT).map((item, i) =>
            <Text key={`${item.code}-${i}`} size='s' className={styles.listRow}>
                {item.code}{item.message ? ` — ${item.message}` : ''}
            </Text>)}
        {items.length > LIST_LIMIT
            && <Text size='s' mode='sub'>{TR('backfill_more', { count: items.length - LIST_LIMIT })}</Text>}
    </Flex>
}

/**
 * הוספת מוצרים מהקטלוג המלא — add the Comax items the nightly import never saw.
 *
 * The import only brings what a store is stocking, so an item that is out of
 * stock everywhere has no catalog row at all. This reads a full-catalog export
 * from Comax and adds the missing rows (server/api/comax_product/backfill_catalog).
 * Items Comax has archived (seasonal stock) are added too, flagged archived so
 * they stay off the site until Comax brings them back.
 *
 * The server owns parsing, matching and writing; this modal only carries the
 * file and the report. `בדיקה בלבד` plans without asking Comax anything, so the
 * admin sees how many codes are missing before a single lookup runs. Apply runs
 * are bounded: while `נשארו` is above zero the 'הרצה הבאה' button repeats the
 * call, and the numbers shown are the total across those runs.
 */
export default function BackfillCatalogModal({ onDone }) {
    const { TR } = useText()
    const fileRef = useRef(null)
    const [file, setFile] = useState(null)
    const [report, setReport] = useState(null)
    const [totals, setTotals] = useState(null)
    const [error, setError] = useState(null)
    const [busy, setBusy] = useState(false)
    const [withGs1, setWithGs1] = useState(false)

    function handleFile(e) {
        const picked = e.target.files?.[0]
        e.target.value = ''
        if (!picked) return
        setError(null)
        setReport(null)
        setTotals(null)
        if (!/\.csv$|text\/csv/i.test(`${picked.name} ${picked.type}`)) {
            setError('backfill_not_csv')
            return
        }
        const reader = new FileReader()
        reader.onload = () => {
            const csv = String(reader.result || '')
            if (csv.length > MAX_CSV_CHARS) {
                setError('backfill_file_too_large')
                setFile(null)
                return
            }
            setFile({ name: picked.name, csv })
        }
        reader.onerror = () => setError('backfill_not_csv')
        reader.readAsText(picked)
    }

    async function run(dryRun) {
        if (!file?.csv) {
            setError('backfill_no_file')
            return
        }
        setError(null)
        setBusy(true)
        try {
            const res = await apiReq('comax_product/backfill_catalog', {
                csv: file.csv,
                dryRun,
                limit: BATCH,
                gs1: withGs1
            })
            setReport(res)
            if (!dryRun) {
                setTotals(prev => totalize(prev || { skipped: {} }, res))
                onDone?.()
            }
        } catch (err) {
            // 'Comax unreachable: …' arrives as the server's own message. 429 is
            // the router's duplicate-request guard, not a rate limit.
            setError(err?.status === 429 ? 'backfill_locked' : err?.message || String(err))
        } finally {
            setBusy(false)
        }
    }

    const stats = !report || report.dryRun ? report : totals
    const remaining = report && !report.dryRun ? report.remaining : 0
    // An apply run that left nothing to read has done its job: the button stays
    // off until a new check says there is something to add.
    const finished = !!report && !report.dryRun && remaining === 0

    return <Flex col gap={14} className={styles.modal}>
        <Text size='s' mode='sub'>{TR('backfill_hint')}</Text>
        <Text size='s' mode='sub'>{TR('backfill_columns')}</Text>

        <Flex gap={10} alignItems='center' wrap>
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
                onClick={() => fileRef.current?.click()}
                text={TR('backfill_file')}
            />
            {file && <Text size='s'>{file.name}</Text>}
        </Flex>

        <Flex gap={8} alignItems='center'>
            <input
                type='checkbox'
                checked={withGs1}
                onChange={e => setWithGs1(e.target.checked)}
                style={{ accentColor: 'var(--bg-brand-primary)' }}
            />
            <Text size='s'>{TR('backfill_gs1')}</Text>
        </Flex>

        {error && <Text size='s' mode='error' className={styles.error}>{TR(error)}</Text>}

        <Flex gap={10} alignItems='center'>
            <Button
                type='button'
                mode='outline'
                icon='search'
                disabled={!file || busy}
                onClick={() => run(true)}
                text={TR('backfill_check')}
            />
            <Button
                type='button'
                icon='upload'
                disabled={!report || !report.targets || busy || finished}
                onClick={() => run(false)}
                text={TR('backfill_apply')}
            />
            {busy && <Loader />}
        </Flex>

        {stats && <Flex col gap={6} className={styles.report}>
            <Flex gap={16} wrap>
                <Stat TR={TR} label='backfill_codes' value={stats.codes} />
                <Stat TR={TR} label='backfill_known' value={stats.known} />
                <Stat TR={TR} label='backfill_targets' value={stats.targets} />
                <Stat TR={TR} label='backfill_found' value={stats.found} />
                <Stat TR={TR} label='backfill_inserted' value={stats.inserted} />
                <Stat TR={TR} label='backfill_refreshed' value={stats.refreshed} />
                <Stat TR={TR} label='backfill_existing' value={stats.existing} />
                <Stat TR={TR} label='backfill_archived' value={stats.archived} />
                <Stat TR={TR} label='backfill_no_price_list' value={stats.noPriceList} />
                <Stat TR={TR} label='backfill_buying_price' value={stats.withBuyingPrice} />
                <Stat TR={TR} label='backfill_zero_price' value={stats.zeroPrice} />
                <Stat TR={TR} label='backfill_errors' value={stats.errorCount} />
            </Flex>

            <Flex gap={16} wrap>
                {SKIPS.map(key =>
                    <Stat key={key} TR={TR} label={`backfill_skip_${key}`} value={stats.skipped?.[key]} />)}
                {!!stats.gs1 && <Stat TR={TR} label='backfill_gs1_queued' value={stats.gs1} />}
            </Flex>

            {totals?.runs > 1
                ? <Text size='s' mode='sub'>{TR('backfill_runs', { count: totals.runs })}</Text>
                : null}

            <Text size='s' mode='sub'>
                {TR(report?.dryRun ? 'backfill_dry_note' : 'backfill_applied_note')}
            </Text>

            <ItemList TR={TR} title='backfill_invalid' items={report?.invalid} />
            <ItemList TR={TR} title='backfill_failed' items={report?.errors} />
        </Flex>}

        {remaining > 0 && <Flex col gap={8}>
            <Text size='s'>{TR('backfill_remaining', { count: remaining })}</Text>
            <Flex>
                <Button
                    type='button'
                    icon='sync'
                    disabled={busy}
                    onClick={() => run(false)}
                    text={TR('backfill_run_next')}
                />
            </Flex>
        </Flex>}
    </Flex>
}
