import { fileURLToPath, URL } from 'node:url'
import { execSync } from 'node:child_process'
import { readFileSync, globSync } from 'node:fs'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { getConnectableHost, normalizeLoopbackHost } from './shared/networkHosts.js'

// The src/ tree hosts BOTH vitest tests (import from 'vitest') and legacy
// node:test tests (import from 'node:test') under the same .test.ts(x) name.
// vitest cannot run node:test files, so route them out by their import source
// — the only honest discriminator — instead of a brittle hand-kept path list.
// Computed lazily and only consulted by the `test` block (ignored by builds).
function nodeTestFiles() {
  try {
    return globSync('src/**/*.test.{ts,tsx}')
      .filter((f) => /from ['"]node:test['"]/.test(readFileSync(f, 'utf8')))
  } catch {
    return []
  }
}

// Single source of truth for BUILD_ID — used in both the inline asset plugin
// and the define constant so dist/version.json and __BUILD_ID__ are guaranteed
// to be identical.
const BUILD_ID = (() => {
  try {
    return execSync('git rev-parse --short=12 HEAD').toString().trim()
  } catch {
    const d = new Date()
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
      String(d.getHours()).padStart(2, '0'),
      String(d.getMinutes()).padStart(2, '0'),
      String(d.getSeconds()).padStart(2, '0'),
    ].join('')
  }
})()

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  const configuredHost = env.HOST || '0.0.0.0'
  // if the host is not a loopback address, it should be used directly. 
  // This allows the vite server to EXPOSE all interfaces when the host 
  // is set to '0.0.0.0' or '::', while still using 'localhost' for browser 
  // URLs and proxy targets.
  const host = normalizeLoopbackHost(configuredHost)
  
  const proxyHost = getConnectableHost(configuredHost)
  // TODO: Remove support for legacy PORT variables in all locations in a future major release, leaving only SERVER_PORT.
  const serverPort = env.SERVER_PORT || env.PORT || 3001

  return {
    plugins: [
      react(),
      // Emits dist/version.json at build time with the same BUILD_ID baked into
      // the bundle via define.__BUILD_ID__ — guarantees both values are identical.
      {
        name: 'nassaj-build-id',
        apply: 'build',
        generateBundle() {
          this.emitFile({
            type: 'asset',
            fileName: 'version.json',
            source: JSON.stringify({ buildId: BUILD_ID }),
          })
        },
      },
    ],
    define: {
      __BUILD_ID__: JSON.stringify(BUILD_ID),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      proxy: {
        '/api': `http://${proxyHost}:${serverPort}`,
        '/ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/shell': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        },
        '/plugin-ws': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-codemirror': [
              '@uiw/react-codemirror',
              '@codemirror/lang-css',
              '@codemirror/lang-html',
              '@codemirror/lang-javascript',
              '@codemirror/lang-json',
              '@codemirror/lang-markdown',
              '@codemirror/lang-python',
              '@codemirror/theme-one-dark'
            ],
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-clipboard', '@xterm/addon-webgl']
          }
        }
      }
    },
    // Frontend unit tests (vitest). Test code imports { describe, it, expect, vi }
    // explicitly from 'vitest', so globals stay off and cleanup is called by hand.
    // This block is inert for `vite build` — Vite ignores `test` at build time.
    test: {
      environment: 'jsdom',
      globals: false,
      include: ['src/**/*.test.{ts,tsx}'],
      // Keep node:test files out of vitest (they run under tsx --test).
      exclude: nodeTestFiles(),
    }
  }
})
