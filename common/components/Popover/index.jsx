import classNames from 'common/functions/classNames'
import Button from 'common/components/Button'
import events from 'common/features/events'
import styles from './popover.module.css'
import { registerPopover, popoverOpened, popoverClosed } from './registry'
import { useEffect, useId, useRef } from 'react'

export default function Popover({ id, className, button, children, btnClassName, disabled, leftOffset = 0, topOffset = 0, icon, overlay, modal = true, ...props }) {
    const ref = useRef()
    const btnRef = useRef()
    const rafRef = useRef(0)
    const winRafRef = useRef(0)
    const roRef = useRef(null)
    const winResizeRef = useRef(null)
    const closeRef = useRef()
    const positionRef = useRef()
    const escRef = useRef()
    const key = id || useId()
    if (!escRef.current) {
        escRef.current = (e) => {
            if (e.key === 'Escape') closeRef.current?.()
        }
    }

    useEffect(() => {
        return () => {
            cancelAnimationFrame(rafRef.current)
            cancelAnimationFrame(winRafRef.current)
            roRef.current?.disconnect()
            roRef.current = null
            if (winResizeRef.current) {
                window.removeEventListener('resize', winResizeRef.current)
                window.visualViewport?.removeEventListener('resize', winResizeRef.current)
                window.removeEventListener('scroll', winResizeRef.current, true)
                winResizeRef.current = null
            }
        }
    }, [])

    useEffect(() => registerPopover(key, (...args) => closeRef.current?.(...args)), [key])

    useEffect(() => {
        if (id) {
            function handleOpen(data) {
                open()
            }

            events.on(`${id}-popover`, handleOpen)

            return () => events.off(`${id}-popover`, handleOpen)
        }
    }, [id])

    function toggle(e) {
        if (ref.current?.open) {
            close()
            return
        }
        open(e)
    }

    function open(e) {
        if (disabled) return
        e?.stopPropagation()
        e?.preventDefault()
        if (ref.current.open) return
        if (modal) {
            ref.current.showModal()
        } else {
            // Windowed: no focus trap / top-layer, so the header stays
            // interactable and dialogs switch with a single press. The
            // single Header overlay dims the body instead of ::backdrop.
            ref.current.show()
            popoverOpened(key)
            document.addEventListener('keydown', escRef.current)
            events.emit('popover-opened', { id: key })
        }
        // Measure after paint: sibling state updates from the same click
        // (e.g. DeliveryView's popoverOpened) and async content flush before
        // rAF, so top/left derive from final — not stale — dimensions.
        cancelAnimationFrame(rafRef.current)
        rafRef.current = requestAnimationFrame(() => {
            // Force reflow so the .5 -> 1 scale transition below animates
            void ref.current?.offsetWidth
            ref.current?.classList.add(styles.visible)
            watchResize()
            watchViewport()
            positionRef.current?.()
        })
    }

    // rAF-throttled reposition so resize drags cost one layout read per frame.
    // Separate slot from the open-transition rAF so a resize in the same
    // frame can't cancel the .visible class add. Goes through positionRef
    // so resize/content observers (stored once per open) always use the
    // latest render's topOffset/leftOffset/left props instead of open-time values.
    function schedulePosition() {
        cancelAnimationFrame(winRafRef.current)
        winRafRef.current = requestAnimationFrame(() => positionRef.current?.())
    }

    // Viewport resizes and any scroll (window or nested containers, via
    // capture) move the anchor button — re-glue the dialog to it while
    // open. Applies to windowed and modal popovers alike: both are
    // JS-anchored to their button (base CSS disables native centering).
    function watchViewport() {
        if (winResizeRef.current) return
        winResizeRef.current = () => schedulePosition()
        window.addEventListener('resize', winResizeRef.current)
        window.visualViewport?.addEventListener('resize', winResizeRef.current)
        window.addEventListener('scroll', winResizeRef.current, true)
    }

    function unwatchViewport() {
        if (!winResizeRef.current) return
        window.removeEventListener('resize', winResizeRef.current)
        window.visualViewport?.removeEventListener('resize', winResizeRef.current)
        window.removeEventListener('scroll', winResizeRef.current, true)
        winResizeRef.current = null
    }

    // True (unscaled) dialog size regardless of the current .5 -> 1
    // opening transition frame.
    function trueSize() {
        const rect = ref.current.getBoundingClientRect()
        let scale = 1
        try {
            scale = new DOMMatrix(getComputedStyle(ref.current).transform).a || 1
        } catch { }
        return { width: rect.width / scale, height: rect.height / scale }
    }

    function position() {
        const dialog = ref.current
        if (!dialog?.open) return
        const
            btnRect = btnRef.current.getBoundingClientRect(),
            { width: popoverWidth, height: popoverHight } = trueSize(),
            gap = 5

        let
            top = btnRect.top + btnRect.height + gap,
            left = btnRect.left - popoverWidth + btnRect.width

        const
            overflowTop = top + popoverHight > window.innerHeight - gap,
            overflowleft = props.left || left < 0

        if (overflowTop)
            top = btnRect.top - popoverHight - gap
        if (overflowleft)
            left = btnRect.left

        top += topOffset
        left += leftOffset
        left = Math.min(window.innerWidth - popoverWidth - gap, left)
        top = Math.min(window.innerHeight - popoverHight - gap, top)
        left = Math.max(gap, left)
        top = Math.max(gap, top)

        dialog.style.transformOrigin =
            `${overflowTop ? 'bottom' : 'top'} ${overflowleft ? 'left' : 'right'}`
        dialog.style.top = `${top}px`
        dialog.style.left = `${left}px`
    }

    // Content (address forms, window options) can change size after open —
    // keep the dialog glued to its button while it is shown.
    function watchResize() {
        const dialog = ref.current
        if (!dialog || roRef.current) return
        roRef.current = new ResizeObserver(() => {
            if (!ref.current?.open) return
            schedulePosition()
        })
        roRef.current.observe(dialog)
    }

    function close() {
        const dialog = ref.current
        cancelAnimationFrame(rafRef.current)
        cancelAnimationFrame(winRafRef.current)
        document.removeEventListener('keydown', escRef.current)
        unwatchViewport()
        roRef.current?.disconnect()
        roRef.current = null
        popoverClosed(key)
        if (!dialog.open) return
        dialog.classList.remove(styles.visible)
        const onCloseEnd = e => {
            if (e.target !== dialog || e.pseudoElement) return
            if (e.propertyName !== 'transform') return
            dialog.removeEventListener('transitionend', onCloseEnd)
            if (!dialog.open) return
            dialog.close()
        }
        dialog.addEventListener('transitionend', onCloseEnd)
    }

    function closeBD(e) {
        const dialog = ref.current
        if (e.target !== dialog) return
        if (e.detail === 0 || (e.clientX === 0 && e.clientY === 0)) return

        const rect = dialog.getBoundingClientRect()
        const isInDialog = (
            rect.top <= e.clientY && e.clientY <= rect.top + rect.height &&
            rect.left <= e.clientX && e.clientX <= rect.left + rect.width
        )
        if (!isInDialog && dialog.open) {
            e.stopPropagation()
            e.preventDefault()
            close()
        }
    }

    // Latest close for the registry + Escape listener (stable identity),
    // latest position for the resize/content observers (fresh offsets).
    closeRef.current = close
    positionRef.current = position

    return <>
        <dialog
            ref={ref}
            onClick={closeBD}
            className={classNames(className, styles.popover, [styles.overlay, overlay], [styles.windowed, !modal])}>
            {typeof children == 'function' ? children({ close }) : children}
        </dialog>
        <div onClick={toggle} ref={btnRef} className={classNames(btnClassName, styles.btn)}>
            {button || <Button
                mode='text'
                disabled={disabled}
                icon={icon || 'options'}
            />}
        </div>
    </>
}
