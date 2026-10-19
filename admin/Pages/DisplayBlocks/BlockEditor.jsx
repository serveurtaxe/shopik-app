import { memo, useCallback, useState } from 'react'
import apiReq from 'common/functions/apiReq'
import Button from 'common/components/Button'
import Checkbox from 'common/components/Checkbox'
import Flex from 'common/components/Flex'
import Form from 'common/components/Form'
import Text from 'common/components/Text'
import Image from 'common/components/Image'
import Input from 'common/components/Input'
import DateRangeCalendar from 'common/components/DateRangeCalendar'
import { useText } from 'common/texts/TextProvider'
import { getDisplayImageUrl } from 'common/functions/displayImageUrl'
import styles from './displayBlocks.module.css'

const SORT_OPTIONS = [
    { value: 'default', text: 'display_sort_default' },
    { value: 'newest', text: 'display_sort_newest' },
    { value: 'popular', text: 'display_sort_popular' }
]

// Stable per-row ids so SlideRow local state (typed URL, upload indicator)
// doesn't jump rows on reorder/delete. Local uniqueness is enough — the GCS
// path already includes the block id, so no crypto needed.
let slideSeq = 0
function newSlideKey() {
    return `slide-${Date.now().toString(36)}-${(slideSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

// Split an ISO datetime into local date + time parts for the calendar/time inputs.
function splitLocal(iso) {
    if (!iso) return { date: '', time: '' }
    try {
        const d = new Date(iso)
        if (isNaN(d)) return { date: '', time: '' }
        const pad = n => String(n).padStart(2, '0')
        return {
            date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
            time: `${pad(d.getHours())}:${pad(d.getMinutes())}`
        }
    } catch { return { date: '', time: '' } }
}

function parseBarcodes(text) {
    const list = String(text || '').split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
    return list.length ? { barcodes: list } : {}
}

export default function BlockEditor({ block, domainId, domainName, placement, categories = [], allCategories = [], onClose, onSaved }) {
    const { TR } = useText()
    // Live form values from Form onChange. Conditional UI (kind/layout/showAll)
    // derives from here, so no per-field state. Everything else is read from
    // the values passed to save(). Calendar + slides aren't native inputs,
    // so they keep their own state.
    const [vals, setVals] = useState()
    const kind = vals?.kind ?? block?.kind ?? 'banner'
    const layout = vals?.banner?.layout ?? block?.banner?.layout ?? 'carousel'
    const showAll = vals?.carousel?.showAll ?? block?.carousel?.showAll ?? true
    const initialStart = splitLocal(block?.schedule?.start)
    const initialEnd = splitLocal(block?.schedule?.end)
    const [range, setRange] = useState({
        ...(initialStart.date ? { $gte: initialStart.date } : {}),
        ...(initialEnd.date ? { $lte: initialEnd.date } : {}),
    })
    const [slides, setSlides] = useState(() =>
        (block?.banner?.slides || []).map(s => ({ key: newSlideKey(), ...s })))

    // Stable callbacks so memoized BannerFields/SlideRow skip parent
    // re-renders (form values update on every keystroke).
    const patchSlide = useCallback((i, patch) => {
        setSlides(prev => prev.map((s, idx) => idx === i ? { ...s, ...patch } : s))
    }, [])
    const moveSlide = useCallback((i, dir) => {
        setSlides(prev => {
            const j = i + dir
            if (j < 0 || j >= prev.length) return prev
            const next = [...prev]
            const [s] = next.splice(i, 1)
            next.splice(j, 0, s)
            return next
        })
    }, [])
    const removeSlide = useCallback(i => {
        setSlides(prev => prev.filter((_, idx) => idx !== i))
    }, [])
    const addSlide = useCallback(() => {
        setSlides(prev => [...prev, { key: newSlideKey() }])
    }, [])

    async function save(vals) {
        const name = String(vals?.name || '').trim()
        if (!name) throw TR('display_name_required')
        // Disabled inputs aren't submitted — fall back to the block.
        const resolvedKind = block?.kind || vals?.kind || kind
        const startDate = range?.$gte || ''
        const endDate = range?.$lte || ''
        const payload = {
            name,
            // Only carousels have a shopper-facing title.
            ...(resolvedKind === 'product_carousel' && String(vals?.title || '').trim()
                ? { title: String(vals.title).trim() } : {}),
            active: !!vals?.active,
            schedule: {
                ...(startDate ? { start: new Date(`${startDate}T${vals?.schedule?.startTime || '00:00'}`).toISOString() } : {}),
                ...(endDate ? { end: new Date(`${endDate}T${vals?.schedule?.endTime || '00:00'}`).toISOString() } : {})
            }
        }
        if (resolvedKind === 'banner') {
            payload.banner = {
                layout: vals?.banner?.layout || layout,
                autoplaySec: Number(vals?.banner?.autoplaySec) || 0,
                slides: slides.map(s => ({
                    ...(s.key ? { key: s.key } : {}),
                    ...(s.image ? { image: s.image } : {}),
                    ...(s.mobileImage ? { mobileImage: s.mobileImage } : {}),
                    ...(s.link ? { link: s.link } : {}),
                    ...(s.alt ? { alt: s.alt } : {})
                }))
            }
        } else {
            payload.carousel = {
                filter: {
                    ...(vals?.carousel?.filter?.categoryId ? { categoryId: vals.carousel.filter.categoryId } : {}),
                    ...(vals?.carousel?.filter?.onSale ? { onSale: true } : {}),
                    ...(String(vals?.carousel?.filter?.search || '').trim() ? { search: String(vals.carousel.filter.search).trim() } : {}),
                    ...parseBarcodes(vals?.carousel?.filter?.barcodes)
                },
                sort: vals?.carousel?.sort || 'default',
                limit: Math.min(Math.max(Number(vals?.carousel?.limit) || 20, 1), 100),
                autoplaySec: Number(vals?.carousel?.autoplaySec) || 0,
                showAll: !!vals?.carousel?.showAll,
                ...(String(vals?.carousel?.showAllText || '').trim() ? { showAllText: String(vals.carousel.showAllText).trim() } : {})
            }
        }
        try {
            if (block?.id) {
                await apiReq('display_block/update', { id: block.id, kind: resolvedKind, ...payload })
            } else {
                await apiReq('display_block/create', {
                    kind: resolvedKind, domainId, placement, ...payload
                })
            }
            onSaved()
        } catch (e) {
            throw (e?.message || TR('display_save_failed'))
        }
    }

    return <Form
        className={styles.editor}
        action={save}
        onChange={setVals}
        sticky
        submitText="Save"
        actions={<Button type="button" mode="text" onClick={onClose}>Cancel</Button>}
    >
        <Flex col gap={10}>
            <Flex gap={10} justifyContent='space-between'>
                <span className={styles.checkRow}>
                    <Checkbox
                        name="active"
                        label={TR('active')}
                        defaultChecked={block?.active !== false}
                    />
                </span>
                <Text size="s" mode="sub">
                    {TR('display_domain')}: {domainName || domainId}
                    {' · '}{TR('display_placement')}: {placement.type === 'path'
                        ? placement.path
                        : (allCategories.find(c => c.id === placement.categoryId)?.path || placement.categoryId)}
                </Text>
            </Flex>
            <Flex gap={8}>
                <Input
                    type="select"
                    name="kind"
                    label="kind"
                    className={styles.field}
                    defaultValue={block?.kind || 'banner'}
                    disabled={!!block}
                    options={[
                        { value: 'banner', text: 'display_banner' },
                        { value: 'product_carousel', text: 'display_product_carousel' }
                    ]}
                />
                <Input
                    name="name"
                    label="display_admin_name"
                    className={styles.field}
                    required
                    defaultValue={block?.name || ''}
                    placeholder="display_name_ph"
                />
            </Flex>
            {/* Always mounted (hidden when inactive) so typed values survive kind flips. */}
            <div hidden={kind !== 'product_carousel'}>
                <Flex gap={8}>
                    <Input
                        name="title"
                        label="display_block_title"
                        className={styles.field}
                        defaultValue={block?.title || ''}
                        placeholder="display_title_ph"
                    />
                </Flex>
            </div>
            <Flex col gap={6}>
                <Text size="s">display_schedule</Text>
                <DateRangeCalendar
                    value={range}
                    onChange={next => setRange({
                        ...(next?.$gte ? { $gte: next.$gte } : {}),
                        ...(next?.$lte ? { $lte: next.$lte } : {}),
                    })}
                />
                <Flex gap={8}>
                    <Input
                        type="time"
                        name="schedule.startTime"
                        label="display_start_time"
                        className={styles.field}
                        defaultValue={range?.$gte ? (initialStart.time || '00:00') : ''}
                    />
                    <Input
                        type="time"
                        name="schedule.endTime"
                        label="display_end_time"
                        className={styles.field}
                        defaultValue={range?.$lte ? (initialEnd.time || '23:59') : '23:59'}
                    />
                </Flex>
            </Flex>

            <div hidden={kind !== 'banner'}>
                <BannerFields
                    layout={layout}
                    slides={slides}
                    blockId={block?.id}
                    defaultAutoplay={block?.banner?.autoplaySec ?? 5}
                    onPatchSlide={patchSlide}
                    onMoveSlide={moveSlide}
                    onRemoveSlide={removeSlide}
                    onAddSlide={addSlide}
                />
            </div>
            <div hidden={kind !== 'product_carousel'}>
                <CarouselFields
                    categories={categories}
                    allCategories={allCategories}
                    block={block}
                    showAll={showAll}
                />
            </div>
        </Flex>
    </Form>
}

const BannerFields = memo(function BannerFields({ layout, slides, blockId, defaultAutoplay, onPatchSlide, onMoveSlide, onRemoveSlide, onAddSlide }) {
    return <Flex col gap={8}>
        <Flex gap={8}>
            <Input
                type="select"
                name="banner.layout"
                label="display_layout"
                className={styles.field}
                defaultValue={layout}
                options={[
                    { value: 'carousel', text: 'display_layout_carousel' },
                    { value: 'mosaic', text: 'display_layout_mosaic' }
                ]}
            />
            <div hidden={layout !== 'carousel'} className={styles.field}>
                <Input
                    type="number"
                    name="banner.autoplaySec"
                    label="display_autoplay"
                    className={styles.field}
                    min="0"
                    defaultValue={defaultAutoplay}
                />
            </div>
        </Flex>
        {slides.map((slide, i) => (
            <SlideRow
                key={slide.key || `new-${i}`}
                slide={slide}
                index={i}
                blockId={blockId}
                onPatchSlide={onPatchSlide}
                onMoveSlide={onMoveSlide}
                onRemoveSlide={onRemoveSlide}
            />
        ))}
        <Button type="button" size="s" icon="add" onClick={onAddSlide}>
            display_add_slide
        </Button>
    </Flex>
})

const SlideRow = memo(function SlideRow({ slide, index, blockId, onPatchSlide, onMoveSlide, onRemoveSlide }) {
    const { TR } = useText()
    const [url, setUrl] = useState('')
    const [uploading, setUploading] = useState(false)
    const [error, setError] = useState()

    function onPatch(patch) {
        onPatchSlide(index, patch)
    }

    async function uploadTo(path, payload) {
        setUploading(true)
        setError()
        try {
            const res = await apiReq('display_block/upload_image', {
                ...payload,
                variant: path === 'mobileImage' ? 'mobile' : 'desktop',
                ...(blockId ? { blockId, slideKey: slide.key || `slide-${index}` } : {})
            })
            onPatch({ [path]: res.basePath })
            setUrl('')
        } catch (e) {
            setError(e?.message || TR(path === 'image' && payload.sourceUrl ? 'display_fetch_failed' : 'display_upload_failed'))
        } finally {
            setUploading(false)
        }
    }

    function handleFile(e, path) {
        const file = e.target.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
            const dataUrl = String(reader.result || '')
            uploadTo(path, { imageBase64: dataUrl.split(',')[1] || '' })
        }
        reader.readAsDataURL(file)
        e.target.value = ''
    }

    return <div className={styles.slide}>
        <Image src={getDisplayImageUrl(slide.image, 's')} className={styles.slidePreview} />
        <Flex col gap={6} className={styles.slideFields}>
            <Flex gap={6}>
                <label className={styles.fileBtn}>
                    {uploading ? TR('display_uploading') : TR('display_upload_file')}
                    <input type="file" accept="image/*" hidden
                        disabled={uploading}
                        onChange={e => handleFile(e, 'image')} />
                </label>
                <Input
                    name={`slide-url-${index}`}
                    label=""
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder="display_paste_url"
                />
                <Button type="button" size="s" onClick={() => url.trim() && uploadTo('image', { sourceUrl: url.trim() })} loading={uploading}>display_fetch</Button>
            </Flex>
            <Flex gap={6}>
                <label className={styles.fileBtn}>
                    {TR('display_mobile_file')}
                    <input type="file" accept="image/*" hidden
                        disabled={uploading}
                        onChange={e => handleFile(e, 'mobileImage')} />
                </label>
                {slide.mobileImage && <Text size="s" mode="sub">display_mobile_ok</Text>}
                <Input
                    name={`slide-link-${index}`}
                    label=""
                    defaultValue={slide.link || ''}
                    onBlur={e => { if (e.target.value !== (slide.link || '')) onPatch({ link: e.target.value }) }}
                    placeholder="display_link_ph"
                />
                <Input
                    name={`slide-alt-${index}`}
                    label=""
                    defaultValue={slide.alt || ''}
                    onBlur={e => { if (e.target.value !== (slide.alt || '')) onPatch({ alt: e.target.value }) }}
                    placeholder="display_alt_ph"
                />
            </Flex>
            {error && <Text size="s" mode="error">{error}</Text>}
        </Flex>
        <Flex col gap={4}>
            <Button type="button" size="s" mode="text" onClick={() => onMoveSlide(index, -1)}>↑</Button>
            <Button type="button" size="s" mode="text" onClick={() => onMoveSlide(index, 1)}>↓</Button>
            <Button type="button" size="s" icon="trash" mode="text" onClick={() => onRemoveSlide(index)} />
        </Flex>
    </div>
})

const CarouselFields = memo(function CarouselFields({ categories, allCategories = [], block, showAll }) {
    const { TR } = useText()
    const initialCategory = block?.carousel?.filter?.categoryId || ''
    // Preserve a deeper category chosen before the two-level limit (or via API)
    // so editing never silently wipes it.
    const missingCategory = initialCategory && !categories.some(c => c.id === initialCategory)
        ? [{
            value: initialCategory,
            text: allCategories.find(c => c.id === initialCategory)?.path || initialCategory
        }]
        : []
    return <Flex col gap={8}>
        <Flex gap={8}>
            <Input
                type="select"
                name="carousel.filter.categoryId"
                label="display_category"
                className={styles.field}
                defaultValue={initialCategory}
                options={[
                    { value: '', text: 'display_all' },
                    ...categories.map(c => ({ value: c.id, text: c.path || c.name })),
                    ...missingCategory
                ]}
            />
            <Input
                type="select"
                name="carousel.sort"
                label="display_sort"
                className={styles.field}
                defaultValue={typeof block?.carousel?.sort === 'string' ? block.carousel.sort : 'default'}
                options={SORT_OPTIONS}
            />
        </Flex>
        <Flex gap={8}>
            <Input
                name="carousel.filter.search"
                label="display_search_text"
                className={styles.field}
                defaultValue={block?.carousel?.filter?.search || ''}
                placeholder="display_search_ph"
            />
            <Input
                type="number"
                name="carousel.limit"
                label="display_max_products"
                className={styles.field}
                min="1"
                max="100"
                defaultValue={block?.carousel?.limit || 20}
            />
        </Flex>
        <Input
            type="textarea"
            name="carousel.filter.barcodes"
            label="display_barcodes_label"
            className={styles.field}
            style={{ borderRadius: '20px' }}
            rows={3}
            defaultValue={(block?.carousel?.filter?.barcodes || []).join('\n')}
            placeholder={'7290000123456\n7290000654321'}
        />
        <Flex gap={12}>
            <Checkbox
                name="carousel.filter.onSale"
                label={TR('display_on_sale')}
                defaultChecked={!!block?.carousel?.filter?.onSale}
            />
            <Checkbox
                name="carousel.showAll"
                label={TR('display_show_all')}
                defaultChecked={block?.carousel?.showAll !== false}
            />
        </Flex>
        <div hidden={!showAll}>
            <Input
                name="carousel.showAllText"
                label="display_show_all_text"
                className={styles.field}
                defaultValue={block?.carousel?.showAllText || ''}
                placeholder="display_show_all_ph"
            />
        </div>
        <Input
            type="number"
            name="carousel.autoplaySec"
            label="display_autoscroll"
            className={styles.field}
            min="0"
            defaultValue={block?.carousel?.autoplaySec || 0}
        />
    </Flex>
})
