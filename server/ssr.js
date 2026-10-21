import { pathToFileURL } from 'url'
import path from 'path'
import fs from 'fs'

const paths = {
    admin: { root: './admin', build: './build/admin', configFile: './admin/vite.config.js' },
    client: { root: './client', build: './build/client', configFile: './client/vite.config.js' }
}

function injectTemplate(template, { head = '', html = '', data = {} }) {
    // Escape <, >, & and U+2028/2029 so user content (names, product text,
    // "$"-patterns) can't break out of the JSON script tag. Replacement
    // uses a callback so $ sequences in data aren't interpreted.
    const safeJson = JSON.stringify(data)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
    return template
        .replace('<!--app-head-->', () => head)
        .replace('<!--app-html-->', () => html)
        .replace('<!--server-data-->', () => `<script>window.__SD__=${safeJson}</script>`)
}

function inlineCss(html, buildDir) {
    return html.replace(
        /<link\s+rel="stylesheet"[^>]*href="\/(assets\/[^"]+\.css)"[^>]*>/g,
        (_, href) => `<style>${fs.readFileSync(path.resolve(buildDir, href), 'utf-8')}</style>`
    )
}

export default async function (app, bootData) {
    const { utils } = bootData
    const isProd = process.env.NODE_ENV === 'production' || process.env.PRODUCTION === 'true' || Boolean(process.env.PRODUCTION)
    let viteAdmin, viteClient

    // --- 1. הכנת ה-Templates וה-Renderers מראש (לפי הסביבה) ---
    const templates = isProd ? {
        adminIndex: fs.readFileSync(path.resolve(paths.admin.build, 'index.html'), 'utf-8'),
        adminLogin: fs.readFileSync(path.resolve(paths.admin.build, 'Login/login.html'), 'utf-8'),
        clientIndex: inlineCss(fs.readFileSync(path.resolve(paths.client.build, 'index.html'), 'utf-8'), paths.client.build),
    } : null

    // יבוא ה-RenderFn של ה-Client מראש ב-Production
    const prodClientRender = isProd
        ? (await import(pathToFileURL(path.resolve('build/server/entry-server.js')).href)).render
        : null

    if (!isProd) {
        const { createServer } = await import('vite')
        viteAdmin = await createServer({
            root: paths.admin.root,
            configFile: paths.admin.configFile,
            server: { middlewareMode: true, ws: { port: 24680 } },
            appType: 'custom'
        })
        viteClient = await createServer({
            root: paths.client.root,
            configFile: paths.client.configFile,
            server: { middlewareMode: true, ws: { port: 24679 } },
            appType: 'custom'
        })

        app.use((req, res, next) => {
            const host = req.headers.host || ''
            if (host.startsWith('admin.')) {
                return viteAdmin.middlewares(req, res, next)
            }
            return viteClient.middlewares(req, res, next)
        })
    }

    // --- 2. פונקציות עזר קוהרנטיות לקבלת ה-Template ---
    async function getAdminTemplate(req, isAuth) {
        const fileName = isAuth ? 'index.html' : 'Login/login.html'
        if (isProd) return isAuth ? templates.adminIndex : templates.adminLogin

        const raw = fs.readFileSync(path.resolve(paths.admin.root, fileName), 'utf-8')
        return viteAdmin.transformIndexHtml(req.originalUrl, raw)
    }

    async function getClientContext(req) {
        if (isProd) {
            return { template: templates.clientIndex, renderFn: prodClientRender }
        }
        const raw = fs.readFileSync(path.resolve(paths.client.root, 'index.html'), 'utf-8')
        const template = await viteClient.transformIndexHtml(req.originalUrl, raw)
        const { render } = await viteClient.ssrLoadModule('/entry-server.jsx')
        return { template, renderFn: render }
    }

    // --- 3. ROUTES (ללא תנאי PRODUCTION בתוכם!) ---

    // MISSING STATIC FILES -> 404
    app.get('*splat', (req, res, next) => {
        if (path.extname(req.path)) return res.status(404).end()
        next()
    })

    // ADMIN ROUTE
    app.get('*splat', async (req, res, next) => {
        const host = req.headers.host || ''
        const isAdmin = host.startsWith('admin.')
        if (!isAdmin) return next()

        try {
            const data = await utils.data.getAdminData(req, bootData)
            const template = await getAdminTemplate(req, Boolean(data?.user?.id))
            return res.status(200).set('Cache-Control', 'no-store').type('html').end(injectTemplate(template, { data }))
        } catch (error) {
            console.error('Admin SSR Error:', error)
            return res.status(500).send('Internal Server Error')
        }
    })

    // CLIENT ROUTE
    app.get('*splat', async (req, res) => {
        try {
            const data = await utils.data.getClientData(req, bootData)
            // Forward the original request identity to SSR data init calls:
            // they hit the internal API without the browser's cookie jar.
            const ctx = {
                cookie: req.headers.cookie,
                platform: utils.getPlatform(req)
            }
            const { template, renderFn } = await getClientContext(req)
            const { html = '', head = '', status = 200 } = await renderFn({ url: req.originalUrl, data, ctx })

            // Personalized HTML (user/order embedded in window.__SD__) must
            // never sit in shared caches: no-cache alone still allows storage.
            const cacheControl = data?.user?.id
                ? 'private, no-store, no-cache, must-revalidate'
                : 'no-cache'
            return res.status(status).set('Cache-Control', cacheControl).type('html').end(injectTemplate(template, { head, html, data }))
        } catch (error) {
            console.error('Client SSR Error:', error)
            return res.status(500).send('Internal Server Error')
        }
    })
}