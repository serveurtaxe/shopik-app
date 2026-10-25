// Maps a GS1 product payload (GET /external/product/{code}.json) to Shopik Product fields.
// GS1 wins for content — Comax remains the gate for existence (checked by the caller).

import { pruneEmpty } from './prune.js'

const firstValue = arr => (Array.isArray(arr) ? arr.map(e => e?.value).find(v => v != null && v !== '') : undefined) ?? ''

const firstCode = arr =>
    (Array.isArray(arr) ? arr.map(e => e?.code).find(c => c != null && c !== '') : undefined) ?? ''

// Food_Symbol_Red codes → nutrients flags. Red "high in" labels (FSR2 sodium,
// FSR3 sugar, FSR4 saturated fat) and the green symbol (FSR5). FSR1 ("ללא
// סימון") is a no-label marker and is ignored.
export function mapNutrients(additionalInfo) {
    const codes = new Set(
        (additionalInfo?.Food_Symbol_Red || []).map(e => e?.code).filter(Boolean)
    )
    const out = {}
    if (codes.has('FSR2')) out.sodium = true
    if (codes.has('FSR3')) out.sugar = true
    if (codes.has('FSR4')) out.fat = true
    if (codes.has('FSR5')) out.positive = true
    const alcoholRaw = String(additionalInfo?.Alcohol_Percentage_in_Product || '')
    if (/[1-9]/.test(alcoholRaw)) out.alcohol = true
    return out
}

// Diet_Information → [{ code, name }]. Entries are usually { code, value }, but
// suppliers also emit code-less entries that pack several claims into one value
// joined by '|'. Both shapes are normalized; blanks and duplicates are dropped.
export function mapDiet(dietInformation) {
    if (!Array.isArray(dietInformation)) return []
    const out = []
    const seen = new Set()
    for (const entry of dietInformation) {
        const code = entry?.code != null ? String(entry.code).trim() : ''
        const value = entry?.value != null ? String(entry.value) : ''
        const names = value.split('|').map(s => s.trim()).filter(Boolean)
        if (code) {
            if (seen.has(code)) continue
            seen.add(code)
            out.push({ code, name: names.join(', ') })
        } else {
            for (const name of names) {
                const key = `name:${name}`
                if (seen.has(key)) continue
                seen.add(key)
                out.push({ name })
            }
        }
    }
    return out
}

// Kashrut → { rabbinates: [{ code, name }], supervisionType: '<code>' }.
// rabbinates keep the GS1 code (drives ranking/stamp images) and display name;
// supervisionType is the Kosher_Supervision_Type code (food category), labelled
// client-side. Blank/whitespace entries are dropped.
export function mapKashrut(kashrut) {
    if (!kashrut) return {}
    const out = {}

    const rabbinates = []
    const seen = new Set()
    for (const entry of (Array.isArray(kashrut.Rabbinate) ? kashrut.Rabbinate : [])) {
        const name = entry?.value != null ? String(entry.value).trim() : ''
        const code = entry?.code != null ? String(entry.code).trim() : ''
        if (!name && !code) continue
        const key = code || `name:${name}`
        if (seen.has(key)) continue
        seen.add(key)
        rabbinates.push(code ? { code, name } : { name })
    }

    const supervision = firstCode(kashrut.Kosher_Supervision_Type)
    if (rabbinates.length || supervision)
        out.kashrut = { rabbinates, supervisionType: supervision }

    const passover = firstValue(kashrut.Kosher_for_Passover)
    if (passover && passover.includes('כשר לפסח')) out.passoverKashrut = 'kosher'
    return out
}

// Media_Assets_Deleted / Media_Assets_Unchecked:
// {deleted_PL_img:[{value,code}], deleted_HE_img, deleted_360_img} — code YES = removed by supplier
function mediaRemovalFlags(productInfo) {
    const pick = (section, key) => {
        const entry = productInfo?.[section]?.[key]
        const code = Array.isArray(entry) ? entry[0]?.code : entry?.code
        return code === 'YES'
    }
    return {
        deleted: pick('Media_Assets_Deleted', 'deleted_PL_img')
            || pick('Media_Assets_Deleted', 'deleted_HE_img')
            || pick('Media_Assets_Deleted', 'deleted_360_img'),
        unchecked: pick('Media_Assets_Unchecked', 'unchecked_PL_img')
            || pick('Media_Assets_Unchecked', 'unchecked_HE_img')
            || pick('Media_Assets_Unchecked', 'unchecked_360_img')
    }
}

function parseGs1Date(raw) {
    if (!raw) return null
    // '2024-11-10 08:45:43' → ISO
    const d = new Date(String(raw).replace(' ', 'T'))
    return Number.isNaN(d.getTime()) ? null : d
}

const isEmpty = v =>
    v == null || v === '' || (Array.isArray(v) && !v.length)
    || (typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)

// Defined-key extras subdocument. Only non-empty sections are set.
function mapGs1Details(item, info, main, general, marketing, additional) {
    const logisticsAdd = info.Logistics_and_Commercial_Properties_Additional || {}
    const out = {}

    if (!isEmpty(main.Net_Content)) out.netContent = main.Net_Content
    if (Array.isArray(main.Country_of_Origin) && main.Country_of_Origin.length)
        out.origin = main.Country_of_Origin
    const dimensions = {
        product: info.Product_Dimensions,
        tray: info.Tray_Dimensions,
        kase: info.Case_or_Carton_Dimensions,
        pallet: info.Pallet_or_Logistic_Unit_Dimensions
    }
    Object.keys(dimensions).forEach(k => { if (isEmpty(dimensions[k])) delete dimensions[k] })
    if (Object.keys(dimensions).length) out.dimensions = dimensions
    if (!isEmpty(logisticsAdd.Product_Shelf_Life)) out.shelfLife = logisticsAdd.Product_Shelf_Life

    const components = info.Product_Components_and_Instructions_General || {}
    // pruneEmpty, not a literal: blank leaves arrive as undefined and isEmpty
    // only counts keys, so a literal would leave a dangling `mayContain: []`.
    const allergens = pruneEmpty({
        contains: components.Allergen_Type_Code_and_Containment,
        mayContain: components.Allergen_Type_Code_and_Containment_May_Contain
    })
    if (allergens) out.allergens = allergens
    if (Array.isArray(components.Diet_Information) && components.Diet_Information.length)
        out.diet = components.Diet_Information

    const serving = {
        suggestion: additional.Serving_Suggestion,
        storage: additional.Consumer_Storage_Instructions,
        size: additional.Serving_Size_Description,
        fatPct: additional.Fat_Percentage_in_Product,
        creamPct: additional.Cream_Percentage_in_Product,
        fruitPct: additional.Fruit_Percentage_in_Product,
        alcoholPct: additional.Alcohol_Percentage_in_Product
    }
    Object.keys(serving).forEach(k => { if (isEmpty(serving[k])) delete serving[k] })
    if (Object.keys(serving).length) out.serving = serving

    const nutrition = pruneEmpty({
        main: info.Nutritional_Values,
        additional: info.Additional_Nutritional_Values
    })
    if (nutrition) out.nutrition = nutrition

    const messages = [
        marketing.Trade_Item_Marketing_Message,
        marketing.Trade_Item_Marketing_Message_2,
        marketing.Trade_Item_Marketing_Message_3,
        marketing.Trade_Item_Marketing_Message_4,
        marketing.Trade_Item_Marketing_Message_5,
        marketing.Trade_Item_Marketing_Message_6,
        marketing.Trade_Item_Marketing_Message_7
    ].filter(v => v != null && v !== '')
    if (messages.length) out.marketing = { messages }

    if (!isEmpty(info.European_Mode_Fields)) out.eu = info.European_Mode_Fields
    if (!isEmpty(info.Product_Management_Mode))
        out.eu = { ...(out.eu || {}), managementMode: info.Product_Management_Mode }

    const ids = {
        gln: main.GLN,
        supplierCatalog: main.Supplier_Catalog_Number,
        manufacturerCode: general.Manufacturer_Product_Code,
        gpc: main.GPC_Category_Code,
        effectiveDate: main.Effective_Date_Time,
        discontinued: general.Discontinued_Date_Time,
        productStatus: info.Internal_System_Fields?.Product_Status,
        targetMarket: general.Target_Market,
        manufacturer: pruneEmpty({
            name: general.Manufacturer_Name,
            address: general.Manufacturer_Address
        }),
        tradeUnit: main.Trade_Item_Unit_Descriptor
    }
    Object.keys(ids).forEach(k => { if (isEmpty(ids[k])) delete ids[k] })
    if (Object.keys(ids).length) out.ids = ids

    return out
}

export function mapGs1ToProduct(payload) {
    // One prune, one object: mapping and the stored raw are derived from the
    // same tree, so they can never disagree. Idempotent, so re-mapping an
    // already-pruned stored raw (enrich.js) is a no-op.
    const item = pruneEmpty(payload) || {}
    const info = item?.product_info || {}
    const main = info.Main_Fields || {}
    const general = info.General_Information || {}
    const marketing = info.Marketing_Information || {}
    const components = info.Product_Components_and_Instructions_General || {}
    const additional = info.Additional_Information || {}
    const system = info.System_Features || {}
    const internal = info.Internal_System_Fields || {}

    const gtin = String(main.GTIN || '').trim()
    if (!gtin) throw new Error('GS1 item missing Main_Fields.GTIN')

    const name = main.Short_Description || main.Trade_Item_Description || ''
    const marketingTexts = [
        general.Additional_Trade_Item_Description_1,
        marketing.Trade_Item_Marketing_Message,
        marketing.Trade_Item_Marketing_Message_2,
        marketing.Trade_Item_Marketing_Message_3,
        marketing.Trade_Item_Marketing_Message_4,
        marketing.Trade_Item_Marketing_Message_5,
        marketing.Trade_Item_Marketing_Message_6,
        marketing.Trade_Item_Marketing_Message_7
    ].filter(v => v != null && v !== '')
    const description = marketingTexts.join('\n').trim()
    const keywords = String(general.Search_Words || '')
        .split(',').map(s => s.trim()).filter(Boolean).slice(0, 20)

    const doc = {
        barcode: gtin,
        name,
        producer: general.Manufacturer_Name || '',
        netContentText: main.Net_Content?.text || '',
        label: main.BrandName || main.Variant || main.Sub_Brand_Name || '',
        regulatoryInfo: components.Ingredient_Sequence_and_Name || '',
        keywords,
        gs1ProductCode: internal.product_code || '',
        gs1SyncedAt: new Date()
    }
    if (description) doc.description = description
    Object.assign(doc, mapKashrut(info.Kashrut))
    const nutrients = mapNutrients(additional)
    if (Object.keys(nutrients).length) doc.nutrients = nutrients
    const diet = mapDiet(components.Diet_Information)
    if (diet.length) doc.diet = diet
    if (!doc.kashrut) delete doc.kashrut
    if (main.Supplier_Catalog_Number) doc.externalSerialNumber = main.Supplier_Catalog_Number
    if (internal.Name) doc.googleCategory = internal.Name
    const details = mapGs1Details(item, info, main, general, marketing, additional)
    if (Object.keys(details).length) doc.gs1 = details

    // Heavy supplier payload lives in the gs1_products collection, not on Product.
    const rawDoc = {
        barcode: gtin,
        productCode: internal.product_code || '',
        modificationTime: parseGs1Date(system.modification_timestamp),
        assetCount: (item.media_assets || []).length,
        raw: item,
        syncedAt: new Date()
    }

    return {
        doc,
        rawDoc,
        gtin,
        productCode: internal.product_code || '',
        modificationTime: rawDoc.modificationTime,
        mediaAssets: Array.isArray(item.media_assets) ? item.media_assets : [],
        removal: mediaRemovalFlags(info)
    }
}

export default { mapGs1ToProduct, mapKashrut, mapDiet, mapNutrients }
