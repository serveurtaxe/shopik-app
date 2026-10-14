import whatsappUrl from './whatsappUrl.js'

export default function openWhatsApp(number, onClose) {
    const url = whatsappUrl(number)
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
    onClose?.()
}
