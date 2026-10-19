function esc(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}

/**
 * Map a packed Shopik order to a Write_DeliveryDocument SOAP request
 * (DeliveryDocuments.asmx). Prices come from the Comax price list
 * (PriceFromPriceList=true), so no per-line Price is sent.
 * Quantity = finalAmount (packed qty); missing / finalAmount<=0 lines omitted.
 *
 * Item key: ClsItems.ID = ComaxProduct.comaxId resolved by barcode
 * (idByBarcode map built by the caller); falls back to the barcode itself —
 * in this install they are identical for ~92% of products.
 *
 * NOTE: Comax requires every documented parameter tag to be present, even
 * when empty — optional tags are emitted empty, never omitted. The flat
 * sibling params (PriceListID, Reference, CustomerName, …) mirror the proven
 * Postman sample; core values live inside DocumentDetails per the WSDL.
 */
export function buildDeliveryDocumentSoap(
    order,
    { customerId, comaxStoreId, priceListId, loginId, loginPassword, idByBarcode = new Map() },
    opts = {}
) {
    const cart = Array.isArray(order?.cart) ? order.cart : []
    const lines = []
    for (const l of cart) {
        const qty = Number(l?.finalAmount ?? l?.amount ?? 0)
        if (!Number.isFinite(qty) || qty <= 0) continue
        const barcode = String(l?.barcode || '').trim()
        const resolved = barcode ? idByBarcode.get(barcode) : ''
        const id = String(resolved || barcode).trim()
        if (!id) continue
        lines.push({ id, qty: String(qty) })
    }

    const fullName = `${order?.name?.first || ''} ${order?.name?.last || ''}`.trim()
    const addr = order?.address || {}
    const street = String(addr.street || '')
    const building = addr.building != null ? String(addr.building) : ''
    const fullAddress = [street, building ? `מס ${building}` : ''].filter(Boolean).join(' ')
    const city = String(addr.city || '')
    const phone = String(order?.phone || '')
    const reference = String(order?.number || '')

    // Per-line: ID + Quantity only. The endpoint 500s on empty
    // value-type tags (Price, DiscountPercent, BaseLine, …), and Comax
    // prices the lines from the price list anyway.
    const itemsXml = lines
        .map(l => `<ClsItems><ID>${esc(l.id)}</ID><Quantity>${esc(l.qty)}</Quantity></ClsItems>`)
        .join('')

    // Value-type tags (int/long/double/enum) are OMITTED when empty —
    // this install 500s on empty value tags. String tags are always
    // emitted (even empty). Booleans are always sent with real values.
    const vtag = (tag, v) => (v == null || String(v).trim() === '' ? '' : `<${tag}>${esc(v)}</${tag}>`)

    const documentDetails = [
        '<DocumentDetails>',
        `<CustomerID>${esc(customerId)}</CustomerID>`,
        '<DateDoc></DateDoc>',
        '<ReferenceDate></ReferenceDate>',
        '<PaymentDate></PaymentDate>',
        `<StoreID>${esc(comaxStoreId)}</StoreID>`,
        `<PriceListID>${esc(priceListId)}</PriceListID>`,
        vtag('AgentID', ''),
        vtag('DiscountPercent', ''),
        vtag('DocNumber', ''),
        '<ManualDocNumber>false</ManualDocNumber>',
        `<Reference>${esc(reference)}</Reference>`,
        '<Reference2></Reference2>',
        '<Remarks></Remarks>',
        '<InnerRemarks></InnerRemarks>',
        '<Details></Details>',
        '<Mode>Add</Mode>',
        vtag('OrderNumber', ''),
        vtag('OrderYear', ''),
        '<SetItemPriceByOrder>false</SetItemPriceByOrder>',
        '<DeliveryDate></DeliveryDate>',
        '<DeliveryHourFrom></DeliveryHourFrom>',
        '<DeliveryHourTo></DeliveryHourTo>',
        `<DeliveryAddress>${esc(street)}</DeliveryAddress>`,
        `<DeliveryAddressNumber>${esc(building)}</DeliveryAddressNumber>`,
        `<DeliveryCity>${esc(city)}</DeliveryCity>`,
        vtag('DeliveryZip', ''),
        `<DeliveryContactMan>${esc(fullName)}</DeliveryContactMan>`,
        `<DeliveryRemark>${esc(addr.comment || '')}</DeliveryRemark>`,
        vtag('DeliveryFloor', addr.floor || ''),
        vtag('DeliveryFlat', addr.apartment != null ? String(addr.apartment) : ''),
        `<DeliveryTelephone>${esc(phone)}</DeliveryTelephone>`,
        `<DeliveryTelephone2>${esc(order?.secondPhone || '')}</DeliveryTelephone2>`,
        `<DeliveryEmail>${esc(order?.email || '')}</DeliveryEmail>`,
        vtag('DeliveryType', ''),
        vtag('UserID', ''),
        '<DoubleReferenceChk>true</DoubleReferenceChk>',
        vtag('CustomerMakat', ''),
        '<Customer>',
        `<Name>${esc(fullName)}</Name>`,
        `<Street>${esc(street)}</Street>`,
        `<Street_No>${esc(building)}</Street_No>`,
        `<City>${esc(city)}</City>`,
        `<Phone>${esc(phone)}</Phone>`,
        '<Zip></Zip>',
        '</Customer>',
        `<Items>${itemsXml}</Items>`,
        '<PriceFromPriceList>true</PriceFromPriceList>',
        '</DocumentDetails>'
    ].join('')

    // Flat siblings mirror the proven Postman sample (same values).
    // Disabled by default: this install rejects unknown top-level elements.
    const flatSiblings = opts.flatSiblings ? [
        `<PriceListID>${esc(priceListId)}</PriceListID>`,
        vtag('AgentID', ''),
        '<Remarks></Remarks>',
        '<Details></Details>',
        `<Reference>${esc(reference)}</Reference>`,
        vtag('OrderNumber', ''),
        '<GetOrderData>false</GetOrderData>',
        '<DateDoc></DateDoc>',
        '<ReferenceDate></ReferenceDate>',
        '<PaymentDate></PaymentDate>',
        `<CustomerName>${esc(fullName)}</CustomerName>`,
        `<CustomerAddress>${esc(fullAddress)}</CustomerAddress>`,
        `<CustomerCity>${esc(city)}</CustomerCity>`,
        `<CustomerPhone>${esc(phone)}</CustomerPhone>`,
        '<CustomerZip></CustomerZip>',
        '<CustomerIDCard></CustomerIDCard>',
        '<SendCredit></SendCredit>',
        '<CreditPaysNumber></CreditPaysNumber>',
        '<CreditCompany></CreditCompany>',
        '<CreditTransactionType></CreditTransactionType>',
        '<CreditExpireDate></CreditExpireDate>',
        '<CreditCardNumber></CreditCardNumber>',
        '<CreditTokenNumber></CreditTokenNumber>',
        '<CreditCVV></CreditCVV>',
        '<CreditTZ></CreditTZ>',
        '<OrderItemsSupplierID></OrderItemsSupplierID>',
        '<SupplierDirectDelivery></SupplierDirectDelivery>',
        '<SendPDFToSupplier></SendPDFToSupplier>',
        '<ClubCustomerId></ClubCustomerId>'
    ].join('') : ''

    const xml = [
        '<?xml version="1.0" encoding="utf-8"?>',
        '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">',
        '<soap:Body>',
        '<Write_DeliveryDocument xmlns="http://ws.comax.co.il/Comax_WebServices/">',
        documentDetails,
        flatSiblings,
        `<LoginID>${esc(loginId)}</LoginID>`,
        `<LoginPassword>${esc(loginPassword)}</LoginPassword>`,
        '</Write_DeliveryDocument>',
        '</soap:Body>',
        '</soap:Envelope>'
    ].join('')
    return { xml, lines }
}
