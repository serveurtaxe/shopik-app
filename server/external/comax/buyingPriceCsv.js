export function parseCsv(input) {
    const rows = []
    let row = []
    let field = ''
    let inQuotes = false

    for (let i = 0; i < input.length; i++) {
        const c = input[i]
        if (inQuotes) {
            if (c === '"') {
                if (input[i + 1] === '"') { field += '"'; i++ }
                else inQuotes = false
            } else field += c
        } else if (c === '"') inQuotes = true
        else if (c === ',') { row.push(field); field = '' }
        else if (c === '\n') { row.push(field); rows.push(row); row = []; field = '' }
        else if (c !== '\r') field += c
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row) }

    return rows
}

// Comax price-list export columns: [0]=price list id, [2]=barcode, [4]=unit price.
export function parseBuyingPriceCsv(text, { priceListId } = {}) {
    const prices = new Map()
    const conflicts = []
    let skipped = 0

    for (const row of parseCsv(text)) {
        if (priceListId && String(row[0] ?? '').trim() !== String(priceListId)) continue

        const barcode = String(row[2] ?? '').trim()
        const price = Number(String(row[4] ?? '').trim())
        if (!barcode || !Number.isFinite(price) || price <= 0) { skipped++; continue }

        if (prices.has(barcode) && prices.get(barcode) !== price)
            conflicts.push({ barcode, from: prices.get(barcode), to: price })
        prices.set(barcode, price)
    }

    return { prices, conflicts, skipped }
}
