// export-allow-paths.mjs — the SINGLE SOURCE of the public-export PATH allow-list.
//
// Two surfaces must agree on EXACTLY which tracked paths ship in the public tree:
//   1. scripts/export-public.sh (the builder) — pipes its `git ls-files`/`ls-tree`
//      list through this module (`--filter`) and copies only what it returns.
//   2. the SHIPPED scripts/public-operations-boundary.test.mjs — scans only the
//      paths this module admits, so the leak gate it enforces matches what ships
//      (before, it scanned the whole tracked tree, including never-exported paths
//      like alkindy/decisions/*, and was permanently red — qa finding 3a).
//
// This file NAMES ONLY path prefixes, never an operator secret, so it is
// leak-clean and ships itself (export-public.sh carries a narrow allow exception
// for it, exactly as for export-allow.mjs, and the leak gate still scans it).
//
// The rules are a WHITELIST: a path is public only if it matches an ALLOW rule.
// A new private directory added tomorrow is therefore excluded BY DEFAULT.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Operator-coupled files that must never ship even though they live under an
// allowed prefix. Each reads or embeds our private layout / identity:
//   - the deletion-writer inventory test reads the private governance inventory;
//   - android-wrapper.yml needs the excluded android-wrapper/ tree;
//   - release.yml runs an excluded tests/integration step and pins the operator's
//     /usr/bin/node;
//   - the release orchestrator and its internals push to OUR private+public repos
//     and carry the private repo owner literally;
//   - the orchestrator's own tests carry that owner and the operator's name/email
//     as fixtures, so they leak exactly like their subjects and are private CI only;
//   - the export builder, its test and the content linker describe OUR layout;
//   - prepare-release-version.test.mjs asserts on the excluded release.yml, so its
//     subject is absent in the public tree.
const DENY_EXACT = new Set([
    'server/modules/database/deletion-writer-inventory.test.ts',
    '.github/workflows/android-wrapper.yml',
    '.github/workflows/release.yml',
    'scripts/export-public.sh',
    'scripts/export-public.test.mjs',
    'scripts/link-content.sh',
    'scripts/release.mjs',
    'scripts/release.test.mjs',
    'scripts/lib/release-orchestrator-journal.mjs',
    'scripts/lib/release-orchestrator-phases.mjs',
    'scripts/release-orchestrator-journal.test.mjs',
    'scripts/release-orchestrator-phases.test.mjs',
    'scripts/release-orchestrator-sandbox.test.mjs',
    'scripts/prepare-release-version.test.mjs',
]);

// The operator-gate helpers carry the exact forbidden tokens they hunt for and
// are private CI only — EXCEPT the two neutral, leak-clean modules the shipped
// boundary test imports (the allow-list values and this path allow-list itself).
const OPERATOR_GATE_ALLOW = new Set([
    'scripts/operator-gate/export-allow.mjs',
    'scripts/operator-gate/export-allow-paths.mjs',
]);

// Enumerated ops/ boundary: `ops/*` also holds operator-only material, so only the
// reviewed first-cutover units and their maintenance-order drop-ins ship.
const OPS_ALLOW = new Set([
    'ops/nassaj-first-cutover-recovery.service',
    'ops/nassaj-maintenance.service',
    'ops/nassaj-cutover-gate-restore.service',
    'ops/systemd/cloudflared.service.d/20-nassaj-maintenance-order.conf',
    'ops/systemd/pm2-nassaj.service.d/20-nassaj-maintenance-order.conf',
    'ops/systemd/pm2-nassaj-dev.service.d/20-nassaj-maintenance-order.conf',
    'ops/systemd/nassaj-first-cutover-recovery.service.d/20-nassaj-maintenance-order.conf',
]);

// Repo-root files that ship verbatim (build/lint config, licence, examples).
const ROOT_ALLOW = new Set([
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.preview.json',
    'vite.config.js', 'tailwind.config.js', 'postcss.config.js', 'eslint.config.js',
    'commitlint.config.js', 'index.html', '.nvmrc',
    'eslint-style-lock-plugin.js', 'STYLE_LOCK.md',
    '.gitignore', '.npmignore', '.release-it.json', 'release.sh',
    '.env.example', 'ecosystem.config.example.cjs',
    'LICENSE', 'NOTICE', 'CONTRIBUTING.md', 'CHANGELOG.md',
]);

const APP_PREFIXES = ['src/', 'server/', 'shared/', 'public/', 'docker/', 'plugins/', 'redirect-package/'];

/**
 * Decide whether a tracked repository path is part of the PUBLIC export.
 * @param {string} relative a POSIX repo-relative path (as `git ls-files` emits)
 * @returns {boolean} true when the path ships in the public tree
 */
export function isPublicExportPath(relative) {
    if (DENY_EXACT.has(relative)) return false;

    if (APP_PREFIXES.some(prefix => relative.startsWith(prefix))) return true;

    if (relative.startsWith('scripts/')) {
        if (OPERATOR_GATE_ALLOW.has(relative)) return true;
        if (relative.startsWith('scripts/operator-gate/')) return false;
        return true;
    }

    if (relative.startsWith('.github/') || relative.startsWith('.husky/')) return true;

    if (relative.startsWith('ops/')) return OPS_ALLOW.has(relative);

    if (ROOT_ALLOW.has(relative)) return true;
    // README.md and README.<lang>.md.
    if (/^README(?:\.[^/]+)?\.md$/.test(relative)) return true;
    // The team wiki ships as user documentation.
    if (relative.startsWith('docs/team-wiki/')) return true;

    return false;
}

/** Split a NUL-delimited buffer into non-empty path entries. */
function splitNul(text) {
    return text.split('\0').filter(Boolean);
}

/**
 * CLI: `node export-allow-paths.mjs --filter` reads a NUL-delimited path list on
 * stdin and writes the admitted paths NUL-delimited on stdout, so the bash builder
 * consumes exactly this decision without re-implementing it.
 */
function runFilterCli() {
    const input = readFileSync(0, 'utf8');
    const kept = splitNul(input).filter(isPublicExportPath);
    process.stdout.write(kept.map(entry => `${entry}\0`).join(''));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    if (process.argv.includes('--filter')) runFilterCli();
    else { process.stderr.write('usage: export-allow-paths.mjs --filter  (NUL-delimited stdin/stdout)\n'); process.exitCode = 2; }
}
