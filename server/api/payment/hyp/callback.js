import { recordPaidOrder } from '#server/utils/data/userStats.js'

function buildLoaderHtml({ ok, orderNumber, errorMessage }) {
    const safeNum = String(orderNumber || '').replace(/</g, '&lt;')
    const safeErr = String(errorMessage || '').replace(/</g, '&lt;').replace(/'/g, '&#39;')
    // minimal ~0.6kb, no bundle - spinner + postMessage to parent Checkout
    return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${ok ? 'אושר' : 'שגיאה'}</title><style>html,body{margin:0;height:100%}body{display:grid;place-items:center;background:#fff;font-family:system-ui,Heebo,Arial,sans-serif} .l{width:36px;height:36px;border:3px solid #EEF2F1;border-top-color:#195855;border-radius:50%;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}} p{margin-top:12px;color:#65716E;font-size:13px}</style></head><body><div style="text-align:center"><div class="l" style="margin:0 auto"></div><p>${ok ? 'מעבד...' : safeErr || 'שגיאה'}</p></div><script>(function(){try{var d={type:'hyp_callback',ok:${ok ? 'true' : 'false'},orderNumber:'${safeNum}',error:'${safeErr}'};var t='*';try{t=window.location.origin||'*'}catch(e){}try{parent.postMessage(d,t)}catch(e){}try{window.top.postMessage(d,t)}catch(e){} }catch(e){}})();<\/script></body></html>`
}

export default async function callback(payload, info) {
    const { DL, external, utils, query, req, res } = info
    const q = query || {}
    // raw query string preserving original order for VERIFY
    let rawQueryString = ''
    try {
        const url = req?.originalUrl || req?.url || ''
        const idx = url.indexOf('?')
        if (idx !== -1) rawQueryString = url.slice(idx + 1)
    } catch { }
    if (!rawQueryString) rawQueryString = new URLSearchParams(q).toString()

    const hyp = external.hyp
    const orderNumber = q.Order || q.order
    const providerTxnId = q.Id || q.id
    const ccodeRaw = q.CCode ?? q.Ccode ?? q.ccode
    const providerCode = ccodeRaw !== undefined ? Number(ccodeRaw) : undefined
    const amountRaw = q.Amount

    // Helper to send minimal loader HTML (no bundle) + postMessage to parent
    function sendHtml({ ok, order, errorMessage }) {
        const html = buildLoaderHtml({ ok, orderNumber: order?.number || orderNumber, errorMessage })
        res.status(ok ? 200 : 400).type('html').send(html)
    }

    // 1. VERIFY
    let verify
    try {
        verify = await hyp.verifyRedirect({ query: q, rawQueryString })
    } catch (e) {
        try {
            const orderFallback = orderNumber ? await DL.Order.readOne({ number: String(orderNumber) }) : null
            const { record } = utils.data.timeline
            if (orderFallback?.id) {
                await record({
                    DL,
                    order: orderFallback,
                    eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
                    actor: null,
                    context: { step: 'payment_failed', provider: 'hyp', providerCode, providerTxnId, amount: amountRaw ? Number(amountRaw) : undefined, orderNumber },
                    outcome: { success: false, errorMessage: e.message || 'VERIFY failed' },
                    metadata: { source: 'payment/hyp/callback', referenceOrderNumber: orderFallback.number }
                })
            }
        } catch { }
        sendHtml({ ok: false, order: null, errorMessage: 'אימות התשלום נכשל' })
        return
    }

    if (!verify || Number(verify.CCode) !== 0) {
        const msg = hyp.ccodeMessage(verify?.CCode ?? providerCode)
        try {
            const orderFallback = orderNumber ? await DL.Order.readOne({ number: String(orderNumber) }) : null
            if (orderFallback?.id) {
                const { record } = utils.data.timeline
                await record({
                    DL, order: orderFallback,
                    eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
                    actor: null,
                    context: { step: 'payment_failed', provider: 'hyp', providerCode: verify?.CCode ?? providerCode, providerTxnId, amount: amountRaw ? Number(amountRaw) : undefined, orderNumber },
                    outcome: { success: false, errorMessage: msg },
                    metadata: { source: 'payment/hyp/callback' }
                })
            }
        } catch { }
        sendHtml({ ok: false, order: null, errorMessage: msg })
        return
    }

    // 2. Lookup order
    if (!orderNumber) {
        sendHtml({ ok: false, order: null, errorMessage: 'חסר מספר הזמנה' })
        return
    }
    const order = await DL.Order.readOne({ number: String(orderNumber) })
    if (!order) {
        res.status(404).type('html').send(buildLoaderHtml({ ok: false, orderNumber, errorMessage: 'ההזמנה לא נמצאה' }))
        return
    }

    // 3. Idempotency — same providerTxnId already processed
    if (providerTxnId) {
        const existing = await DL.PaymentTransaction.readOne({ providerTxnId: String(providerTxnId) })
        if (existing) {
            const isSuccess = existing.status === DL.PaymentTransaction.constants.TRANSACTION_STATUS.SUCCESS
            sendHtml({ ok: isSuccess, order, errorMessage: existing.error })
            return
        }
    }

    // 4. Handle CCode from redirect: {0,700} success
    const isSuccessCode = providerCode === 0 || providerCode === 700
    if (!isSuccessCode) {
        const msg = hyp.ccodeMessage(providerCode)
        try {
            await DL.PaymentTransaction.create({
                domainId: order.domainId, storeId: order.storeId,
                orderId: order.id, orderNumber: order.number, userId: order.userId,
                provider: 'hyp', kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.AUTH,
                status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.FAILED,
                amount: amountRaw ? Number(amountRaw) : undefined,
                providerTxnId: providerTxnId ? String(providerTxnId) : undefined,
                providerCode, authCode: q.ACode || q.acode, providerUid: q.UID, providerPayerId: q.UserId, signature: q.Sign, providerData: q, error: msg
            })
        } catch { }
        try {
            const { record } = utils.data.timeline
            await record({
                DL, order,
                eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
                actor: null,
                context: { step: 'payment_failed', provider: 'hyp', providerCode, providerTxnId, amount: amountRaw ? Number(amountRaw) : undefined, orderNumber },
                outcome: { success: false, errorMessage: msg },
                metadata: { source: 'payment/hyp/callback' }
            })
        } catch { }
        await DL.Order.updateOne({ id: order.id }, { paymentError: msg }).catch(() => { })
        sendHtml({ ok: false, order, errorMessage: msg })
        return
    }

    // 5. Success → getToken
    let tokenData
    try {
        tokenData = await hyp.getToken(String(providerTxnId))
    } catch (e) {
        const msg = e.message || 'getToken failed'
        try {
            await DL.PaymentTransaction.create({
                domainId: order.domainId, storeId: order.storeId,
                orderId: order.id, orderNumber: order.number, userId: order.userId,
                provider: 'hyp', kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.AUTH,
                status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.FAILED,
                amount: amountRaw ? Number(amountRaw) : undefined,
                providerTxnId: String(providerTxnId), providerCode, authCode: q.ACode, providerUid: q.UID, providerPayerId: q.UserId, signature: q.Sign, providerData: { ...q, tokenError: msg }, error: msg
            })
        } catch { }
        sendHtml({ ok: false, order, errorMessage: msg })
        return
    }

    if (Number(tokenData.CCode) !== 0 || !tokenData.Token) {
        const msg = hyp.ccodeMessage(tokenData.CCode)
        try {
            await DL.PaymentTransaction.create({
                domainId: order.domainId, storeId: order.storeId,
                orderId: order.id, orderNumber: order.number, userId: order.userId,
                provider: 'hyp', kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.AUTH,
                status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.FAILED,
                amount: amountRaw ? Number(amountRaw) : undefined,
                providerTxnId: String(providerTxnId), providerCode: tokenData.CCode, authCode: q.ACode, providerUid: q.UID, providerPayerId: q.UserId, signature: q.Sign,
                cardToken: tokenData.Token, cardExpiry: tokenData.Tokef, providerData: { ...q, tokenResponse: tokenData }, error: msg
            })
        } catch { }
        sendHtml({ ok: false, order, errorMessage: msg })
        return
    }

    // 6. Persist auth success
    const cardToken = tokenData.Token
    const cardExpiry = tokenData.Tokef
    const authorizedAmount = amountRaw ? Number(amountRaw) : order.finalSumWithShipping ?? order.finalSum
    const last4digits = q.L4digit ? String(q.L4digit) : undefined
    const cardCompany = hyp.cardBrandName(q.Brand)

    try {
        await DL.PaymentTransaction.create({
            domainId: order.domainId, storeId: order.storeId,
            orderId: order.id, orderNumber: order.number, userId: order.userId,
            provider: 'hyp', kind: DL.PaymentTransaction.constants.TRANSACTION_KIND.AUTH,
            status: DL.PaymentTransaction.constants.TRANSACTION_STATUS.SUCCESS,
            amount: Number(authorizedAmount),
            terminalId: process.env.HYP_MASOF || undefined,
            providerTxnId: String(providerTxnId), providerCode, authCode: q.ACode, providerUid: q.UID, providerPayerId: q.UserId, signature: q.Sign,
            cardToken, cardExpiry, last4digits, cardCompany, providerData: { ...q, tokenResponse: tokenData }
        })
    } catch { }

    try {
        await DL.Order.updateOne({ id: order.id }, {
            status: DL.Order.constants.ORDER_STATUS.PAID,
            payment: {
                provider: 'hyp',
                providerTxnId: String(providerTxnId),
                authCode: q.ACode ? String(q.ACode) : undefined,
                providerUid: q.UID ? String(q.UID) : undefined,
                providerPayerId: q.UserId ? String(q.UserId) : undefined,
                cardToken, cardExpiry,
                last4digits, cardCompany,
                terminalId: process.env.HYP_MASOF || undefined,
                authorizedAmount: Number(authorizedAmount)
            },
            paymentError: null
        })
    } catch { }

    // Maintain user_stats on first successful checkout (cart -> paid).
    // Idempotent: duplicate callbacks return early at the providerTxnId
    // check above, and re-auths on an already-paid order don't re-count.
    if (order.status === DL.Order.constants.ORDER_STATUS.CART) {
        try {
            await recordPaidOrder(DL, order, Number(authorizedAmount))
        } catch { }
        await utils.data.orderSms.sendOrderStageSms({
            DL,
            external,
            order,
            stage: 'paid'
        })
    }

    try {
        const { record } = utils.data.timeline
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.PAYMENT,
            actor: null,
            context: { step: 'payment_authorized', provider: 'hyp', providerTxnId: String(providerTxnId), authCode: q.ACode, providerUid: q.UID, amount: Number(authorizedAmount), last4digits, cardCompany, orderNumber },
            outcome: { success: true },
            metadata: { source: 'payment/hyp/callback', referenceOrderNumber: order.number }
        })
    } catch { }

    try {
        const { record } = utils.data.timeline
        await record({
            DL, order,
            eventType: DL.Timeline.constants.EVENT_TYPES.ORDER_STATUS_UPDATE,
            actor: null,
            changes: { oldData: { status: order.status }, newData: { status: DL.Order.constants.ORDER_STATUS.PAID } },
            context: { step: 'payment_authorized', provider: 'hyp', orderNumber },
            outcome: { success: true },
            metadata: { source: 'payment/hyp/callback', referenceOrderNumber: order.number }
        })
    } catch { }

    sendHtml({ ok: true, order })
}

callback.config = {
    auth: 'none',
    log: true
}
