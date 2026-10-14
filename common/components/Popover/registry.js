/**
 * Singleton registry of open Popovers so windowed (non-modal) popovers
 * coordinate: opening one closes the others, and the single Header overlay
 * reflects whether any popover is open (via subscribePopoverCount).
 */
const closers = new Map()
const openKeys = new Set()
const subs = new Set()

function notify() {
    subs.forEach(fn => {
        try { fn(openKeys.size) } catch { }
    })
}

export function registerPopover(key, closeFn) {
    closers.set(key, closeFn)
    return () => {
        closers.delete(key)
        if (openKeys.delete(key)) notify()
    }
}

export function popoverOpened(key) {
    closers.forEach((close, k) => {
        if (k !== key) {
            try { close() } catch { }
        }
    })
    openKeys.add(key)
    notify()
}

export function popoverClosed(key) {
    if (openKeys.delete(key)) notify()
}

export function closeAllPopovers() {
    ;[...closers.values()].forEach(close => {
        try { close() } catch { }
    })
}

export function subscribePopoverCount(fn) {
    subs.add(fn)
    return () => subs.delete(fn)
}
