import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import path from 'path'
import fs from 'fs'

const currentDir = import.meta.dirname

const pkgPath = path.resolve(currentDir, '../package.json')
const { version } = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))

const alias = {
  // `public` is Vite's publicDir (copied verbatim to the build root). Aliasing it
  // would shadow any package literally named `public`.
  ...fs.readdirSync(currentDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== 'public')
    .reduce((a, { name }) => ({
      ...a,
      [name]: path.resolve(currentDir, name),
      [name[0].toUpperCase() + name.slice(1)]: path.resolve(currentDir, name),
      [name[0].toLowerCase() + name.slice(1)]: path.resolve(currentDir, name),
    }), {}),
  common: path.resolve(currentDir, '..', 'common'),
}
export default defineConfig(({ mode }) => {
  // `vite build` runs without server/boot.js, so .env is NOT in process.env.
  // loadEnv reads it (root .env); real env still wins (container deploys).
  const fileEnv = loadEnv(mode, path.resolve(currentDir, '..'), '')
  const CARTO_KEY_VAL = process.env.CARTO_KEY || fileEnv.CARTO_KEY || ''
  const FILES_BASE_URL_VAL = process.env.FILES_BASE_URL || fileEnv.FILES_BASE_URL || 'https://files.shopik.co.il'
  return {
  root: currentDir,
  cacheDir: '../node_modules/.vite-admin',
  base: '/',
  resolve: { alias },
  plugins: [react()],
  define: {
    APP_VERSION: JSON.stringify(version),
    CARTO_KEY: JSON.stringify(CARTO_KEY_VAL),
    VITE_FILES_BASE_URL: JSON.stringify(FILES_BASE_URL_VAL)
  },
  build: {
    outDir: '../build/admin',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        main: path.resolve(currentDir, 'index.html'),
        login: path.resolve(currentDir, 'Login/login.html'),
      },
    }
  },

  css: {
    modules: {
      generateScopedName: (name, fileName) => {
        const pathParts = fileName.split('/')
        const fn = pathParts.at(-2) || 'style'
        if (!fn || fn.length === 0) return name
        const lowerCaseFN = `${fn[0].toLowerCase()}${fn.substring(1)}`
        return `${fn}_${lowerCaseFN == name ? '' : name}`
      }
    },
  }
  }
})