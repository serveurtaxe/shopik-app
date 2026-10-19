import { createContext, useContext } from 'react'
import hebrewTexts from './hebrew.json'
import TR from './TR.js'

const TextContext = createContext({})
export const useText = () => useContext(TextContext)


export default function TextProvider({ children }) {

    return <TextContext.Provider value={{ TR, ...hebrewTexts }}>
        {children}
    </TextContext.Provider>
}