import { clientGenerationAssets, generationBase, publicAssetPaths } from './scripts/client-generation-vite.mjs'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync, globSync, lstatSync, realpathSync, readdirSync, statSync } from 'node:fs'
import { resolve as resolvePath, dirname as dirnamePath, isAbsolute as pathIsAbsolute } from 'node:path'
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

// Vite refuses to serve any file whose real path falls outside the project root,
// and that refusal reaches vitest too (a denied `?raw` import fails the whole test
// file, not just one assertion). `docs/` is allowed to be a SYMLINK into a separate
// content repository — the wiki pages are content, not code — so its real path can
// legitimately sit outside this tree.
//
// Resolved here rather than written as a literal: this must name no absolute path
// (it ships publicly), and in a checkout where `docs/` is a plain directory inside
// the project the realpath resolves back into the root, making this a no-op.
const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url))

/** Keep build and test caches outside the dependency tree sealed by the updater. */
export function resolveClientCacheDir(projectRoot, stagingDirectory = null, environment = process.env) {
  const suppliedRoot = environment.NASSAJ_CLIENT_CACHE_ROOT
  let cacheRoot = stagingDirectory ? dirnamePath(stagingDirectory) : resolvePath(projectRoot)
  if (suppliedRoot !== undefined) {
    if (!stagingDirectory || environment.NASSAJ_ATOMIC_CLIENT_BUILD !== '1'
      || !pathIsAbsolute(suppliedRoot) || suppliedRoot.split(/[\\/]/).includes('..')) {
      throw new Error('Client cache root requires a canonical atomic candidate directory.')
    }
    cacheRoot = realDirectory(suppliedRoot, 'Client candidate cache root')
  }
  const cacheDir = suppliedRoot === undefined
    ? resolvePath(cacheRoot, '.artifacts', 'vite-cache', String(process.pid))
    : resolvePath(cacheRoot, 'build-cache', 'vite')
  if (cacheDir.split(/[\\/]/).includes('node_modules')) {
    throw new Error('Client cache cannot write into dependencies.')
  }
  // Refuse aliases in existing parents before Vite creates missing directories.
  for (let cursor = cacheDir; cursor !== dirnamePath(cursor); cursor = dirnamePath(cursor)) {
    try { realDirectory(cursor, 'Client cache directory') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return cacheDir
}

function realDirectory(directory, label) {
  const resolved = resolvePath(directory)
  const metadata = lstatSync(resolved)
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(resolved) !== resolved) {
    throw new Error(`${label} must be an existing real directory.`)
  }
  return resolved
}

/**
 * Resolve the only build output directory Vite may write.
 *
 * OID previews read source from a read-only snapshot, but stage output under the
 * canonical project root.  The canonical root is derived from the snapshot's
 * real path; the environment value must attest that same root and cannot choose
 * an arbitrary write location.
 */
export function resolveAtomicClientOutDir(projectRoot, environment = process.env) {
  const sourceRoot = realDirectory(projectRoot, 'Client source root')
  const requestedRaw = environment.NASSAJ_CLIENT_OUT_DIR || ''
  if (!pathIsAbsolute(requestedRaw) || requestedRaw.split(/[\\/]/).includes('..')) {
    throw new Error('Atomic client outDir must be an absolute canonical path without parent traversal.')
  }
  const requestedOutDir = resolvePath(requestedRaw)
  const stagingNameIsValid = /^dist\.atomic\.predeploy-staging-[a-f0-9]{12}-\d+$/.test(
    requestedOutDir.split('/').at(-1) || '',
  )
  if (!stagingNameIsValid) {
    throw new Error('Atomic client outDir must use an approved project-disk staging parent; live dist is forbidden.')
  }

  let approvedParent = sourceRoot
  if (environment.NASSAJ_LOCAL_PREVIEW === '1') {
    const suppliedPreviewRoot = environment.NASSAJ_CLIENT_PREVIEW_ROOT
    if (suppliedPreviewRoot) {
      if (!pathIsAbsolute(suppliedPreviewRoot) || suppliedPreviewRoot.split(/[\\/]/).includes('..')) {
        throw new Error('OID preview root must be an absolute canonical path without parent traversal.')
      }
      const oid = sourceRoot.split('/').at(-1) || ''
      const snapshotsRoot = realDirectory(dirnamePath(sourceRoot), 'OID snapshots root')
      const controlRoot = realDirectory(dirnamePath(snapshotsRoot), 'OID preview control root')
      const derivedPreviewRoot = realDirectory(dirnamePath(controlRoot), 'Canonical preview root')
      if (!/^[a-f0-9]{40}$/.test(oid)
        || snapshotsRoot !== resolvePath(derivedPreviewRoot, '.nassaj-local-preview/oid-snapshots')
        || controlRoot !== resolvePath(derivedPreviewRoot, '.nassaj-local-preview')) {
        throw new Error('Client source root is not an exact OID snapshot path.')
      }
      const attestedPreviewRoot = realDirectory(suppliedPreviewRoot, 'Attested preview root')
      if (attestedPreviewRoot !== derivedPreviewRoot) {
        throw new Error('Attested preview root does not match the OID snapshot root.')
      }
      approvedParent = realDirectory(
        resolvePath(attestedPreviewRoot, '.nassaj-local-preview/client'),
        'OID client staging parent',
      )
    } else {
      approvedParent = realDirectory(
        resolvePath(sourceRoot, '.nassaj-local-preview/client'),
        'Local client staging parent',
      )
    }
  }

  if (dirnamePath(requestedOutDir) !== approvedParent) {
    throw new Error('Atomic client outDir must use an approved project-disk staging parent; live dist is forbidden.')
  }
  const realStaging = realDirectory(requestedOutDir, 'Atomic client staging directory')
  if (realStaging !== requestedOutDir) {
    throw new Error('Atomic client staging directory must be canonical.')
  }
  return requestedOutDir
}
function contentRoots() {
  const docs = fileURLToPath(new URL('./docs', import.meta.url))
  const roots = []
  try {
    roots.push(realpathSync(docs))
    // docs/ itself is a real directory; the ENTRIES inside it are what may be
    // linked out (the wiki pages, the board). Resolving only `docs` would leave
    // those real paths outside the allow-list — the exact mistake that made
    // `import.meta.glob('/docs/team-wiki/*.md')` fail under vitest.
    for (const entry of readdirSync(docs, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue
      const real = realpathSync(resolvePath(docs, entry.name))
      roots.push(statSync(real).isDirectory() ? real : dirnamePath(real))
    }
  } catch {
    // No docs/ in this checkout — nothing to allow.
  }
  return [...new Set(roots)]
}

// Single source of truth for BUILD_ID — used in both the inline asset plugin
// and the define constant so dist/version.json and __BUILD_ID__ are guaranteed
// to be identical.
export default defineConfig(({ command, mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '')

  // Production client builds are promoted atomically by client-build-atomic.mjs.
  // A raw `vite build` writes into the live dist/ incrementally and can leave
  // browsers with an HTML/asset mismatch, so fail closed before Vite starts.
  if (command === 'build' && process.env.NASSAJ_ATOMIC_CLIENT_BUILD !== '1') {
    throw new Error('Raw vite build is disabled; use npm run build:client (atomic publisher).')
  }
  const BUILD_ID = process.env.NASSAJ_BUILD_ID
  if (command === 'build' && !/^[a-f0-9]{64}$/.test(BUILD_ID || '')) {
    throw new Error('NASSAJ_BUILD_ID must be a SHA-256 content digest supplied by the atomic builder.')
  }
  const requestedOutDir = command === 'build'
    ? resolveAtomicClientOutDir(PROJECT_ROOT, process.env)
    : resolvePath(process.env.NASSAJ_CLIENT_OUT_DIR || '')

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
    cacheDir: resolveClientCacheDir(PROJECT_ROOT, command === 'build' ? requestedOutDir : null),
    base: generationBase(process.env.NASSAJ_CLIENT_GENERATION_ID),
    plugins: [
      clientGenerationAssets({ publicDirectory: resolvePath(PROJECT_ROOT, 'public'), generationId: process.env.NASSAJ_CLIENT_GENERATION_ID }),
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
      __PUBLIC_ASSET_PATHS__: JSON.stringify(publicAssetPaths(resolvePath(PROJECT_ROOT, 'public'))),
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url))
      }
    },
    server: {
      host,
      port: parseInt(env.VITE_PORT) || 5173,
      fs: {
        // Explicit list REPLACES vite's default (the project root), so root is
        // listed here too — omitting it would deny the whole tree.
        allow: [PROJECT_ROOT, ...contentRoots()],
      },
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
        // ADR-187: internal team-chat room socket (its own path, never /ws).
        '/internal-session-chat': {
          target: `ws://${proxyHost}:${serverPort}`,
          ws: true
        }
      }
    },
    build: {
      outDir: requestedOutDir,
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
            'vendor-xterm': ['@xterm/xterm', '@xterm/addon-fit']
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
