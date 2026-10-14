import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseXml } from '../../server/external/comax/parser.js'
import { extractDeliveryDetails, mapDeliveryLine } from '../../server/external/comax/deliveryFetch.js'
import { formatComaxDate } from '../../server/external/comax/utils.js'

const RESPONSE = `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <Get_DeliveryDocument_AllResponse xmlns="http://ws.comax.co.il/Comax_WebServices/">
      <Get_DeliveryDocument_AllResult>
        <GetDos_DetailsOut>
          <CustomerID>102</CustomerID>
          <DateDoc>13/10/2026</DateDoc>
          <StoreID>3</StoreID>
          <DocNumber>6700024</DocNumber>
          <Reference>3535</Reference>
          <TotalScmBeforeVat>100</TotalScmBeforeVat>
          <TotalScm>117</TotalScm>
          <Cmt>2</Cmt>
          <Price>50</Price>
          <PriceWithVat>58.5</PriceWithVat>
          <Discount>0</Discount>
          <Scm>100</Scm>
          <ScmWithVat>117</ScmWithVat>
          <ItemID>6</ItemID>
          <ItemNm>Milk 1L</ItemNm>
          <ItemConvertionQty>0</ItemConvertionQty>
          <Line>0</Line>
          <ErrorMessage></ErrorMessage>
        </GetDos_DetailsOut>
        <GetDos_DetailsOut>
          <CustomerID>102</CustomerID>
          <DateDoc>13/10/2026</DateDoc>
          <StoreID>3</StoreID>
          <DocNumber>6700024</DocNumber>
          <Reference>3535</Reference>
          <TotalScmBeforeVat>100</TotalScmBeforeVat>
          <TotalScm>117</TotalScm>
          <Cmt>1</Cmt>
          <Price>17</Price>
          <PriceWithVat>19.89</PriceWithVat>
          <Discount>0</Discount>
          <Scm>17</Scm>
          <ScmWithVat>19.89</ScmWithVat>
          <ItemID>10</ItemID>
          <ItemNm>Bread</ItemNm>
          <ItemConvertionQty>0</ItemConvertionQty>
          <Line>0</Line>
          <ErrorMessage></ErrorMessage>
        </GetDos_DetailsOut>
      </Get_DeliveryDocument_AllResult>
    </Get_DeliveryDocument_AllResponse>
  </soap:Body>
</soap:Envelope>`

describe('Get_DeliveryDocument_All parsing', () => {
    it('extracts one row per doc line', () => {
        const rows = extractDeliveryDetails(parseXml(RESPONSE))
        assert.equal(rows.length, 2)
        assert.equal(String(rows[0].DocNumber), '6700024')
    })

    it('maps line prices (qty from Cmt, conversion qty ignored)', () => {
        const rows = extractDeliveryDetails(parseXml(RESPONSE))
        assert.deepEqual(mapDeliveryLine(rows[0]), {
            line: null, itemId: '6', itemName: 'Milk 1L', qty: 2,
            price: 50, priceWithVat: 58.5, discount: 0, sum: 100, sumWithVat: 117
        })
        assert.equal(mapDeliveryLine(rows[1]).itemId, '10')
    })

    it('returns [] when the doc is not visible yet', () => {
        const empty = `<?xml version="1.0"?><soap:Envelope xmlns:soap="x"><soap:Body>
            <Get_DeliveryDocument_AllResponse xmlns="y"><Get_DeliveryDocument_AllResult/></Get_DeliveryDocument_AllResponse>
            </soap:Body></soap:Envelope>`
        assert.deepEqual(extractDeliveryDetails(parseXml(empty)), [])
    })

    it('tolerates a single line (object instead of array)', () => {
        const single = `<?xml version="1.0"?><soap:Envelope xmlns:soap="x"><soap:Body>
            <Get_DeliveryDocument_AllResponse xmlns="y"><Get_DeliveryDocument_AllResult>
            <GetDos_DetailsOut><ItemID>6</ItemID><Price>50</Price></GetDos_DetailsOut>
            </Get_DeliveryDocument_AllResult></Get_DeliveryDocument_AllResponse>
            </soap:Body></soap:Envelope>`
        const rows = extractDeliveryDetails(parseXml(single))
        assert.equal(rows.length, 1)
        assert.equal(mapDeliveryLine(rows[0]).price, 50)
    })

    it('formats FromDate as DD/MM/YYYY', () => {
        assert.equal(formatComaxDate(new Date(2026, 9, 13)), '13/10/2026')
    })
})
