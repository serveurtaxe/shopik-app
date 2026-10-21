import apiReq from '#common/functions/apiReq'
import TR from '#common/texts/TR'
import { usePage } from 'layout/Page'
import ProductList, { PRODUCT_LIST_LIMIT } from 'pages/Products/ProductList'

export default function Carousel() {
    const { loading, pageData, path } = usePage()
    const data = pageData?.data
    const block = data?.block

    return <ProductList
        data={data}
        loading={loading}
        notFound={pageData?.notFound}
        title={block?.title || pageData?.title}
        breadcrumbPath={path}
        resetKey={path}
        hideBreadcrumbs
        fetchPage={({ skip, limit }) => apiReq('display_block/carousel', { id: block?.id, skip, limit })}
    />
}

Carousel.init = async function (path, ctx) {
    const id = decodeURIComponent(path).split('/').filter(Boolean).pop()
    try {
        const res = await apiReq('display_block/carousel', { id, limit: PRODUCT_LIST_LIMIT }, ctx)
        return {
            title: res.block?.title || TR('display_fallback_title'),
            description: res.block?.title,
            data: res
        }
    } catch {
        return { notFound: true, title: '404' }
    }
}
