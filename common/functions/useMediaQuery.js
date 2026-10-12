import { useEffect, useState } from 'react'

export default function useMediaQuery(query) {
    const [matches, setMatches] = useState(() =>
        typeof window !== 'undefined' && window.matchMedia(query).matches)
    useEffect(() => {
        const mq = window.matchMedia(query)
        const onChange = e => setMatches(e.matches)
        mq.addEventListener('change', onChange)
        return () => mq.removeEventListener('change', onChange)
    }, [query])
    return matches
}
