// CLI/env parsing + the production guard.
//
// Targets:
//   --target local  prod dump restored locally (rich metrics: profiler + serverStatus)
//   --target test   the test Atlas URI (degraded metrics where Atlas forbids them)
// The runner refuses any URI identical to the app's own DB/DB_URI env so it can
// never accidentally hammer production.

const DEFAULT_LOCAL_URI = 'mongodb://localhost:27017/shopik_stress'

export function parseArgs(argv = process.argv.slice(2)) {
    const opts = {
        target: null,
        mode: 'sequential',
        dbUri: null,
        baseUrl: process.env.STRESS_BASE_URL || 'http://localhost:7777',
        calls: 30,
        concurrency: 10,
        chaosDuration: 60,
        probeEvery: 150,
        gap: 2500,
        baselineSeconds: 10,
        minWindow: 3000,
        slowMs: 20,
        only: null,
        mutations: false,
        idNum: process.env.STRESS_ID_NUM || null,
        userPhone: null,
        headlessOtp: false,
        gatePassword: process.env.STRESS_GATE_PASSWORD || null,
        feedOnly: false,
        feedHost: process.env.STRESS_FEED_HOST || null,
        feedCalls: 10,
        feedConcurrency: 2,
        adminOrigin: null,
        storefrontOrigin: null,
        reportDir: 'reports/stress',
        help: false,
        discoverOnly: false
    }
    const flagsWithValues = new Set(['--target', '--mode', '--db-uri', '--base-url', '--calls', '--concurrency',
        '--chaos-duration', '--probe-every', '--gap', '--baseline-seconds', '--min-window', '--slow-ms', '--only',
        '--id-num', '--user-phone',
        '--gate-password', '--report-dir', '--admin-origin', '--storefront-origin',
        '--feed-host', '--feed-calls', '--feed-concurrency'])
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        switch (arg) {
            case '--mutations': opts.mutations = true; continue
            case '--headless-otp': opts.headlessOtp = true; continue
            case '--feed-only': opts.feedOnly = true; continue
            case '--help': case '-h': opts.help = true; continue
            case '--discover-only': opts.discoverOnly = true; continue
        }
        if (flagsWithValues.has(arg)) {
            const value = argv[++i]
            if (value == null) throw new Error(`${arg} requires a value`)
            const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
            opts[key] = key === 'calls' || key === 'concurrency' || key === 'chaosDuration' || key === 'probeEvery'
                || key === 'gap' || key === 'baselineSeconds' || key === 'minWindow' || key === 'slowMs'
                || key === 'feedCalls' || key === 'feedConcurrency'
                ? Number(value)
                : value
            continue
        }
        throw new Error(`Unknown argument: ${arg}`)
    }

    if (!opts.help && !opts.discoverOnly && !opts.feedOnly) {
        if (!['local', 'test'].includes(opts.target))
            throw new Error('--target must be local or test')
        if (!['sequential', 'chaos', 'both'].includes(opts.mode))
            throw new Error('--mode must be sequential, chaos or both')
    }

    opts.uri = opts.dbUri
        || (opts.target === 'local' ? (process.env.STRESS_DB_URI_LOCAL || DEFAULT_LOCAL_URI) : process.env.STRESS_DB_URI_TEST)
    if (!opts.help && !opts.discoverOnly && !opts.feedOnly && opts.target === 'test' && !opts.dbUri && !process.env.STRESS_DB_URI_TEST)
        throw new Error('--target test needs STRESS_DB_URI_TEST (or --db-uri)')

    if (!opts.adminOrigin) {
        const port = new URL(opts.baseUrl).port || (new URL(opts.baseUrl).protocol === 'https:' ? '443' : '80')
        opts.adminOrigin = `http://admin.localhost:${port}`
    }
    // Storefront traffic gets its domain from the Origin host (resolveDomainId),
    // so the customer session is fired with the plain site origin, not admin.*.
    opts.storefrontOrigin = opts.storefrontOrigin || opts.baseUrl

    // Profiling only on the local target unless explicitly justified: shared
    // Atlas tiers pay for every profiled op.
    opts.profile = opts.target === 'local'

    return opts
}

export function guardAgainstProduction(uri) {
    const prodUris = [process.env.DB, process.env.DB_URI].filter(Boolean)
    const normalize = value => String(value).replace(/\s+/g, '')
    const target = normalize(uri)
    const hit = prodUris.find(prod => normalize(prod) === target)
    if (hit)
        throw new Error(
            'Refusing to run: the stress URI is identical to this environment\u2019s DB/DB_URI ' +
            '(production). Point --db-uri at a local restore or the test cluster.'
        )
    if (process.env.PRODUCTION)
        throw new Error('Refusing to run with PRODUCTION set in the stress runner\u2019s own environment.')
    // WHATWG new URL() chokes on multi-host mongodb:// replica-set lists;
    // parse with a regex and never echo the URI (it carries credentials).
    const match = /^mongodb(\+srv)?:\/\/(?:[^/?@]*@)?([^/?]+)/.exec(uri)
    if (!match)
        throw new Error('Invalid mongo URI (expected mongodb:// or mongodb+srv://)')
    console.log(`[stress] target db host: ${match[2].split(',')[0]}`)
}

export function usage() {
    return `Stress runner — fires read routes at a running Shopik server and watches mongo.

Run the server yourself against the SAME stress DB first, e.g.
  DB=mongodb://localhost:27017/shopik_stress NO_NIGHT_SYNC=1 PORT=7777 npm start

Usage:
  node scripts/stress/run.js --target local|test [options]

  --target local|test     which DB (and its metrics capability class). Required.
  --db-uri <uri>          override the target URI (local: STRESS_DB_URI_LOCAL, test: STRESS_DB_URI_TEST)
  --base-url <url>        running server, default http://localhost:7777
  --mode sequential|chaos|both   default sequential
  --calls <n>             calls per route in a sequential burst (default 30)
  --concurrency <c>       inflight requests (default 10)
  --chaos-duration <s>    chaos window seconds (default 60)
  --probe-every <ms>      probe cadence during bursts (default 250)
  --gap <ms>              cooldown between bursts (default 2500)
  --baseline-seconds <s>  how long the no-load probe baseline runs (default 10; a
                          short one gives a p50/p95 noisy enough to fake 2× impacts)
  --min-window <ms>       every route is burst on repeat until its window lasts this
                          long (default 3000) so the probe gets samples in every window
  --slow-ms <ms>          profiler slowms: only operations at/over it are recorded
                          (default 20; use 1 on a short --only run to see every read)
  --only <regex>          only run matching routes (e.g. --only "order/")
  --mutations             include write routes (default off)
  --id-num <n>            admin idNum for login (or env STRESS_ID_NUM; required
                          before start-up with --headless-otp)
  --user-phone <phone>    shopper to log in as for the storefront routes; without it a
                          real cart-order-with-store owner is sampled from the stress DB
  --storefront-origin <url> Origin header for storefront calls (domain resolution),
                          default --base-url
  --headless-otp          read the OTP from the stress DB instead of prompting (never with a prod-looking URI)
  --gate-password <p>     SITE_GATE_PASSWORD of the target server (or env STRESS_GATE_PASSWORD)
  --report-dir <dir>      default reports/stress
  --discover-only         print the discovered route table and exit (no server/DB needed)
  --feed-only             benchmark ONLY the sitemap + Google feed documents (no DB,
                          no fixtures, no login); needs --feed-host and --base-url
  --feed-host <domain>    Host header to send; the storefront domain the feed resolves
                          (or env STRESS_FEED_HOST)
  --feed-calls <n>        warm calls per feed endpoint in --feed-only (default 10)
  --feed-concurrency <c>  inflight requests in --feed-only (default 2)

Env:
  STRESS_DB_URI_LOCAL / STRESS_DB_URI_TEST / STRESS_BASE_URL / STRESS_GATE_PASSWORD / STRESS_FEED_HOST
`
}
