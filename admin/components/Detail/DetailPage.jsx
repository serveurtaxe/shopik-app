import { useNavigate } from 'react-router'
import Button from 'common/components/Button'
import Flex from 'common/components/Flex'
import LabelChip from './LabelChip'
import styles from './detail.module.css'

/**
 * Shared admin detail-page shell (extracted from the Order page):
 * back button + header (title, labels, meta) + actions row on top,
 * two-column content (main + 360px sidebar) below.
 */
export default function DetailPage({
    onBack,
    backFallback,
    title,
    labels = [],
    meta = null,
    actions = null,
    sidebar = null,
    children,
    className = ''
}) {
    const navigate = useNavigate()
    // Browser-like back: return to the previous page when there is one
    // (e.g. user page -> order -> back to user page), otherwise fall
    // back to the list (direct URL entry with no in-app history).
    const goBack = onBack || (() => {
        if (window.history.state?.idx > 0) navigate(-1)
        else if (backFallback) navigate(backFallback)
        else navigate(-1)
    })
    return <Flex col gap={15} className={`${styles.page} ${className}`}>
        <Flex gap={10} alignItems='center'>
            <Button icon='back' mode='text' onClick={goBack} className={styles.backButton} />
            <Flex gap={4} justifyContent='space-between' alignItems='center' grow>
                <Flex col gap={4} className={styles.header} >
                    <Flex gap={10} alignItems='center' wrap>
                        {title}
                        {(labels || []).map((label, i) => <LabelChip key={i} label={label} />)}
                    </Flex>
                    {meta}
                </Flex>
                {actions}
            </Flex>
        </Flex>
        <Flex gap={15} alignItems='flex-start' className={styles.content}>
            <Flex col gap={15} grow className={styles.mainColumn}>
                {children}
            </Flex>
            {sidebar && <Flex col gap={15} className={styles.sidebar}>
                {sidebar}
            </Flex>}
        </Flex>
    </Flex>
}
