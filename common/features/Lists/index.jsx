import { createContext, useContext, useState } from 'react'
//import styles from './lists.module.css'

const ListContent = createContext({})
export const useLists = () => useContext(ListContent)

export default function Lists({ sdLists, children }) {
    const [lists] = useState(sdLists)
    return <ListContent value={lists}>
        {children}
    </ListContent>
}
