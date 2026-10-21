import apiReq from '#common/functions/apiReq'
import { usePage } from 'layout/Page'
import DisplayBlocks from 'features/Display/DisplayBlocks'
import TR from '#common/texts/TR.js'
import styles from './home.module.css'

export default function Home() {
    const { pageData } = usePage()
    return <div className={styles.home}>
        <DisplayBlocks blocks={pageData?.data?.blocks} />
    </div>
}

Home.init = async function init(url, ctx) {
    const data = await apiReq('display_block/get', { path: '/' }, ctx).catch(() => ({ blocks: [] }))
    return {
        title: TR('page_home_title'),
        data
    }
}
