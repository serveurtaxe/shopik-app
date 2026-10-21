import apiReq from '#common/functions/apiReq'
import { usePage } from 'layout/Page'
import TR from '#common/texts/TR.js'
import ProductList, { PRODUCT_LIST_LIMIT } from 'pages/Products/ProductList'

export default function Sales() {
    const { loading, pageData } = usePage()
    const data = pageData?.data

    return <>
        <ProductList
            data={data}
            loading={loading}
            notFound={pageData?.notFound}
            title={data?.categoryName || pageData?.title || TR('sales')}
            breadcrumbPath='/sales'
            resetKey='sales'
            emptyText={TR('sales_empty')}
            blocks={data?.blocks}
            fetchPage={({ skip, limit }) => apiReq('product/get', { onSale: true, skip, limit })}
        />
    </>
}

Sales.init = async function (url, ctx) {
    const [res, display] = await Promise.all([
        apiReq('product/get', { onSale: true, limit: PRODUCT_LIST_LIMIT }, ctx),
        apiReq('display_block/get', { path: '/sales' }, ctx).catch(() => ({ blocks: [] }))
    ])
    return {
        title: TR('sales'),
        description: TR('page_sales_desc'),
        data: { ...res, blocks: display.blocks || [] }
    }
}
