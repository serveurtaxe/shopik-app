import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react'
import classNames from 'common/functions/classNames'
import { useText } from 'common/texts/TextProvider'
import styles from './horizontalScroll.module.css'
import Button from '../Button'
import Flex from '../Flex'
import Text from '../Text'

export default function HorizontalScroll({ items = [], children = items, className = '', itemClassName = '', autoplaySec = 0, largeArrows = false }) {
    const { TR } = (useText?.() || {})
    const tr = TR || (k => k)
    const scrollContainerRef = useRef(null)
    const [showLeftArrow, setShowLeftArrow] = useState(false)
    const [showRightArrow, setShowRightArrow] = useState(false)
    const pausedRef = useRef(false)
    const dirRef = useRef(1)

    const checkScrollPosition = useCallback(() => {
        const el = scrollContainerRef.current
        if (!el) return

        const { scrollLeft, scrollWidth, clientWidth } = el
        const maxScrollable = scrollWidth - clientWidth

        if (maxScrollable <= 0) {
            setShowLeftArrow(false)
            setShowRightArrow(false)
            return
        }

        const isRtl = getComputedStyle(el).direction === 'rtl'

        if (isRtl) {
            const absScroll = Math.abs(scrollLeft)
            setShowLeftArrow(absScroll < maxScrollable - 2)
            setShowRightArrow(absScroll > 2)
        } else {
            setShowLeftArrow(scrollLeft > 2)
            setShowRightArrow(scrollLeft < maxScrollable - 2)
        }
    }, [])

    // Normalized once per input identity: single child isn't dropped, and the
    // wrapper inherits a stable key from the child when it has one.
    const contentList = useMemo(() => {
        const raw = Array.isArray(children) && children.length > 0 ? children
            : (Array.isArray(items) ? items : [items].filter(v => v != null && v !== false))
        return raw.map((item, index) => ({
            key: (React.isValidElement(item) && item.key != null) ? item.key : `item-${index}`,
            item
        }))
    }, [children, items])
    const contentLength = contentList.length

    useEffect(() => {
        const el = scrollContainerRef.current
        if (!el) return

        checkScrollPosition()

        const rafId = requestAnimationFrame(() => checkScrollPosition())
        const timerId = setTimeout(checkScrollPosition, 100)

        let resizeObserver
        if (typeof ResizeObserver !== 'undefined') {
            resizeObserver = new ResizeObserver(() => checkScrollPosition())
            resizeObserver.observe(el)
            Array.from(el.children).forEach(child => resizeObserver.observe(child))
        }

        el.addEventListener('scroll', checkScrollPosition)
        window.addEventListener('resize', checkScrollPosition)

        return () => {
            cancelAnimationFrame(rafId)
            clearTimeout(timerId)
            if (resizeObserver) resizeObserver.disconnect()
            el.removeEventListener('scroll', checkScrollPosition)
            window.removeEventListener('resize', checkScrollPosition)
        }
    }, [contentLength, checkScrollPosition])

    const hoverScrollRef = useRef(null)

    const stopHoverScroll = useCallback(() => {
        if (hoverScrollRef.current) {
            cancelAnimationFrame(hoverScrollRef.current)
            hoverScrollRef.current = null
            scrollContainerRef.current?.style.removeProperty('scroll-behavior')
        }
    }, [])

    const startHoverScroll = useCallback((direction) => {
        stopHoverScroll()
        const el = scrollContainerRef.current
        if (!el) return

        el.style.scrollBehavior = 'auto'

        const maxSpeed = direction === 'left' ? -450 : 450
        const rampDuration = 0.35
        const isRtl = getComputedStyle(el).direction === 'rtl'
        let elapsed = 0
        let lastTime = performance.now()

        const step = (currentTime) => {
            const container = scrollContainerRef.current
            if (!container) return

            const delta = Math.min((currentTime - lastTime) / 1000, 0.05)
            lastTime = currentTime
            elapsed += delta

            const ramp = Math.min(elapsed / rampDuration, 1)
            const speed = maxSpeed * (0.2 + 0.8 * ramp * ramp)

            const maxScrollable = container.scrollWidth - container.clientWidth
            const absScroll = Math.abs(container.scrollLeft)
            const headingToStart = speed < 0 !== isRtl
            const atLimit = maxScrollable <= 0 ||
                (headingToStart ? absScroll < 0.5 : maxScrollable - absScroll < 0.5)

            if (atLimit) {
                stopHoverScroll()
                return
            }

            container.scrollLeft += speed * delta
            checkScrollPosition()

            hoverScrollRef.current = requestAnimationFrame(step)
        }

        hoverScrollRef.current = requestAnimationFrame(step)
    }, [stopHoverScroll, checkScrollPosition])

    useEffect(() => {
        return () => {
            stopHoverScroll()
        }
    }, [stopHoverScroll])

    const scrollToActive = useCallback(() => {
        const el = scrollContainerRef.current
        const active = el?.querySelector('[data-active]')
        active?.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' })
    }, [])

    useEffect(() => {
        const el = scrollContainerRef.current
        if (!el || typeof MutationObserver === 'undefined') return

        let rafId

        const scheduleScroll = () => {
            cancelAnimationFrame(rafId)
            rafId = requestAnimationFrame(scrollToActive)
        }

        const observer = new MutationObserver(scheduleScroll)
        observer.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-active'] })

        const initialRafId = requestAnimationFrame(() => requestAnimationFrame(scrollToActive))

        return () => {
            observer.disconnect()
            cancelAnimationFrame(rafId)
            cancelAnimationFrame(initialRafId)
        }
    }, [contentLength, scrollToActive])

    const scroll = (direction) => {
        stopHoverScroll()
        const el = scrollContainerRef.current
        if (!el) return

        const scrollAmount = el.clientWidth * 0.75
        const multiplier = direction === 'left' ? -1 : 1

        el.scrollBy({
            left: multiplier * scrollAmount,
            behavior: 'smooth'
        })
    }

    // Opt-in auto-advance (e.g. product carousels). Ping-pongs at the ends so it
    // works the same in RTL and LTR. Paused on hover/touch and hidden tabs.
    useEffect(() => {
        const sec = Number(autoplaySec)
        if (!sec || sec <= 0) return
        const timer = setInterval(() => {
            if (pausedRef.current || document.hidden) return
            const el = scrollContainerRef.current
            if (!el) return
            const maxScrollable = el.scrollWidth - el.clientWidth
            if (maxScrollable <= 2) return
            const absScroll = Math.abs(el.scrollLeft)
            if (absScroll >= maxScrollable - 2) dirRef.current = -1
            else if (absScroll <= 2) dirRef.current = 1
            el.scrollBy({ left: dirRef.current * el.clientWidth * 0.75, behavior: 'smooth' })
        }, sec * 1000)
        return () => clearInterval(timer)
    }, [autoplaySec, contentLength])

    return (
        <Flex className={classNames(styles.wrapper, className)} alignItems='center'
            onMouseEnter={() => { pausedRef.current = true }}
            onMouseLeave={() => { pausedRef.current = false }}
            onTouchStart={() => { pausedRef.current = true }}
            onTouchEnd={() => { pausedRef.current = false }}
        >
            {showLeftArrow && (
                <Button
                    icon='left'
                    className={classNames(styles.arrow, styles.leftArrow, [styles.arrowLarge, largeArrows])}
                    onClick={() => scroll('left')}
                    onMouseEnter={() => startHoverScroll('left')}
                    onMouseLeave={stopHoverScroll}
                    onTouchStart={() => startHoverScroll('left')}
                    onTouchEnd={stopHoverScroll}
                    aria-label={tr('display_scroll_left')}
                />
            )}

            <Flex
                ref={scrollContainerRef}
                className={styles.scrollContainer}
                gap={10}
            >
                {contentList.map(({ key, item }) => (
                    <Flex key={key} className={classNames(styles.item, itemClassName)} shrink={0}>
                        {typeof item === 'string' ? <Text>{item}</Text> : item}
                    </Flex>
                ))}
            </Flex>

            {showRightArrow && (
                <Button
                    icon='right'
                    className={classNames(styles.arrow, styles.rightArrow, [styles.arrowLarge, largeArrows])}
                    onClick={() => scroll('right')}
                    onMouseEnter={() => startHoverScroll('right')}
                    onMouseLeave={stopHoverScroll}
                    onTouchStart={() => startHoverScroll('right')}
                    onTouchEnd={stopHoverScroll}
                    aria-label={tr('display_scroll_right')}
                />
            )}
        </Flex>
    )
}