// Access setup: optional site gate login, then the real login flows the app
// itself uses — admin (ADMIN_TOKEN_COOKIE) for everything, plus the two sessions
// a couple of routes insist on (the picker of an order, and the logged-in
// customer behind the storefront routes).
//
// --headless-otp writes the OTP doc into the stress DB's otps collection instead
// of calling login_otp, so unattended runs never need SMS. The guard in run.js
// already refused a prod-looking URI before this can ever touch an otp collection.
//
// Style/ASI note: keep statements from starting with `(` in this file — a previous
// line that ends in `)` (a `throw`/`console.log` carrying a template literal)
// continues as a call and silently swallows the parenthesised assignment.

import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import uid from '#common/functions/uid.js'
import { maskPhone } from './util.js'

let rl = null
const ask = async question => {
    if (!process.stdin.isTTY)
        throw new Error(`Needs ${question} but stdin is not interactive — pass it as a flag.`)
    rl ??= readline.createInterface({ input, output })
    return (await rl.question(question)).trim()
}

export function closePrompt() {
    rl?.close()
    rl = null
}

// Prompted before fixtures load: with --headless-otp the admin's phone has to
// come from the DB row selected by this idNum, so asking later (inside the login
// flow) is too late.
export async function promptAdminId() {
    return ask('Admin ID number: ')
}

export async function ensureGate(client, { gatePassword }) {
    const probe = await client.call('domain/count', {})
    if (probe.kind !== 'gate') return { gated: false }
    const password = gatePassword || await ask('Site gate password: ')
    if (!password) throw new Error('Target is gated — pass --gate-password (or STRESS_GATE_PASSWORD).')
    const ok = await client.gateLogin(password)
    if (!ok) throw new Error('Gate login rejected (wrong password?).')
    return { gated: true }
}

// login_otp would create this exact doc and then send the SMS — the login route
// only needs the stored pair.
async function headlessOtp(fixtures, phone) {
    const otpToken = uid(16)
    const otp = uid(6, true)
    await fixtures.otpCollection.insertOne({ phone, token: otpToken, otp, attempts: 0, createdAt: new Date() })
    return { otpToken, otp }
}

async function adminOtp(client, fixtures, { idNum, phone, label, headless }) {
    if (headless) {
        if (!phone)
            throw new Error(
                `--headless-otp: no ${label} with idNum "${idNum}" and a phone was found in the stress DB. ` +
                'Pass the right --id-num / STRESS_ID_NUM (or drop --headless-otp).'
            )
        return headlessOtp(fixtures, phone)
    }
    const issued = await client.call('admin/login_otp', { idNum }, { timeoutMs: 15_000, keepBody: true })
    if (!issued.ok)
        throw new Error(`login_otp failed (${issued.status} ${issued.kind}): ${issued.body?.message || '—'} — try --headless-otp if the SMS provider is unreachable in this environment.`)
    const otpToken = issued.body?.data?.token
    if (!otpToken) throw new Error('login_otp returned no token.')
    return { otpToken, otp: await ask('OTP code: ') }
}

export async function adminLogin(client, fixtures, { idNum, phone = null, label = 'admin', headlessOtp: headless }) {
    idNum = idNum || await ask('Admin ID number: ')
    phone = phone || fixtures.adminPhone
    if (phone) console.log(`[stress] login → ${label} phone ${maskPhone(phone)}`)

    const { otpToken, otp } = await adminOtp(client, fixtures, { idNum, phone, label, headless })
    const logged = await client.call('admin/login', { idNum, otpToken, otp }, { timeoutMs: 15_000, keepBody: true })
    if (!logged.ok)
        throw new Error(`${label} login failed (${logged.status} ${logged.kind}): ${logged.body?.message || 'no ADMIN_TOKEN_COOKIE issued'}`)
    return { ok: true }
}

// Storefront session: the router only populates _user for non-admin platforms,
// and getUser rejects a token whose user.tokens[platform] doesn't match the
// platform of the call — so this client says 'web' on the login and on every
// burst (see StressClient.platform).
export async function customerLogin(client, fixtures, { phone, headlessOtp: headless }) {
    if (!phone) return false
    console.log(`[stress] login → customer phone ${maskPhone(phone)}`)

    let otpToken
    let otp
    if (headless) {
        const issued = await headlessOtp(fixtures, phone)
        otpToken = issued.otpToken
        otp = issued.otp
    } else {
        const issued = await client.call('user/login_otp', { phone }, { timeoutMs: 15_000, keepBody: true })
        if (!issued.ok)
            throw new Error(`user/login_otp failed (${issued.status} ${issued.kind}): ${issued.body?.message || '—'} — try --headless-otp.`)
        otpToken = issued.body?.data?.token
        if (!otpToken) throw new Error('user/login_otp returned no token.')
        otp = await ask('OTP code: ')
    }

    const logged = await client.call('user/login', { phone, otpToken, otp }, { timeoutMs: 15_000, keepBody: true })
    if (!logged.ok)
        throw new Error(`customer login failed (${logged.status} ${logged.kind}): ${logged.body?.message || 'no USER_TOKEN_COOKIE issued'}`)
    return true
}

// Ops-queue routes pin to the admin's currentStoreId — without a store they
// answer empty and the burst would measure nothing.
export async function pinCurrentStore(client, fixtures) {
    if (!fixtures.currentStoreId) return false
    const res = await client.call('admin/current_store', { storeId: fixtures.currentStoreId })
    return res.ok
}
