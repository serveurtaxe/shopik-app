// Access setup: optional site gate login, then the real admin login flow the
// app itself uses (login_otp → login → ADMIN_TOKEN_COOKIE).
//
// --headless-otp reads the OTP out of the stress DB's otps collection (or
// writes one directly if the SMS provider is unreachable), so unattended runs
// work. The guard in run.js already refused a prod-looking URI before this can
// ever touch an otp collection.

import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import uid from '#common/functions/uid.js'
import { maskPhone } from './util.js'

export async function ensureGate(client, { gatePassword, interactive }) {
    const probe = await client.call('domain/count', {})
    if (probe.kind !== 'gate') return { gated: false }
    let password = gatePassword
    if (!password && interactive) {
        const rl = readline.createInterface({ input, output })
        password = (await rl.question('Site gate password: ')).trim()
        rl.close()
    }
    if (!password) throw new Error('Target is gated — pass --gate-password (or STRESS_GATE_PASSWORD).')
    const ok = await client.gateLogin(password)
    if (!ok) throw new Error('Gate login rejected (wrong password?).')
    return { gated: true }
}

export async function adminLogin(client, fixtures, { idNum, headlessOtp, interactive }) {
    let rl = null
    const ask = async question => {
        if (!interactive) throw new Error(`Needs ${question} but stdin is not interactive — pass it as a flag.`)
        rl ??= readline.createInterface({ input, output })
        return (await rl.question(question)).trim()
    }

    idNum = idNum || await ask('Admin ID number: ')
    if (fixtures.adminPhone)
        console.log(`[stress] login → admin phone ${maskPhone(fixtures.adminPhone)}`)

    let otpToken, otp

    if (headlessOtp) {
        if (!fixtures.adminPhone)
            throw new Error('--headless-otp needs the admin (by --id-num) to exist in the stress DB.')
        otpToken = uid(16)
        otp = uid(6, true)
        // Bypasses SMS: login_otp would create this exact doc and then send the
        // SMS — the login route only needs the stored pair.
        await fixtures.otpCollection.insertOne({ phone: fixtures.adminPhone, token: otpToken, otp, attempts: 0, createdAt: new Date() })
    } else {
        const issued = await client.call('admin/login_otp', { idNum }, { timeoutMs: 15_000 })
        if (!issued.ok)
            throw new Error(`login_otp failed (${issued.status} ${issued.kind}): ${issued.body?.message || '—'} — try --headless-otp if the SMS provider is unreachable in this environment.`)
        otpToken = issued.body?.data?.token
        if (!otpToken) throw new Error('login_otp returned no token.')
        otp = await ask('OTP code: ')
    }

    const logged = await client.call('admin/login', { idNum, otpToken, otp }, { timeoutMs: 15_000 })
    if (!logged.ok)
        throw new Error(`login failed (${logged.status} ${logged.kind}): ${logged.body?.message || 'no ADMIN_TOKEN_COOKIE issued'}`)
    rl?.close()
    return { ok: true }
}

// Ops-queue routes pin to the admin's currentStoreId — without a store they
// answer empty and the burst would measure nothing.
export async function pinCurrentStore(client, fixtures) {
    if (!fixtures.currentStoreId) return false
    const res = await client.call('admin/current_store', { storeId: fixtures.currentStoreId })
    return res.ok
}
