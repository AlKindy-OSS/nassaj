/**
 * B-1691 (qa F9/F10): every git child the server (and the runtime scripts it
 * imports) spawns carries the shared hardening of shared/git-safety.js.
 *
 * Source scan in the style of the permission-launch inventory: each `'git',`
 * argument (a spawn/execFile/spawnSync argv[0], or `git` inside a `flock` argv)
 * must be followed by `hardenGitArgs(` or a `GIT_*_ARGS` spread. The only other
 * accepted forms are listed below with their reason; a new unhardened spawn, or
 * a stale allowlist entry, fails the test.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Runtime scripts the server imports that run git on project repositories. */
const RUNTIME_SCRIPTS = [
  'scripts/session-commit-arbiter.mjs',
  'scripts/local-preview-ledger.mjs',
  'scripts/preview-oid-pipeline.mjs',
];

/**
 * Accepted without the prefix. `before` must match the text just before `'git',`.
 * The updater files run git only on APP_ROOT (the service's own install or its
 * release remote), never on a project path, and already pass core.hooksPath.
 */
const ALLOWED = [
  { file: 'server/routes/git.js', before: /spawnAsync\(\s*$/, reason: 'spawnAsync hardens every git argv' },
  { file: 'server/index.js', before: /runFile\(\s*$/, reason: 'updater runGit on APP_ROOT' },
  { file: 'server/services/source-updater.js', reason: 'updater, APP_ROOT only' },
  { file: 'server/services/update-prestage-slot.js', reason: 'updater, APP_ROOT only' },
  { file: 'server/services/source-update-candidate-retention.js', reason: 'updater, APP_ROOT only' },
  { file: 'server/services/update-maintenance-gate.js', reason: 'updater, APP_ROOT only' },
  { file: 'server/services/git-tag-release-discovery.js', reason: 'ls-remote of the release remote' },
  { file: 'server/services/preview-runtime-attestation.js', reason: 'rev-parse of APP_ROOT' },
  { file: 'server/services/command-board-custom.js', reason: 'a list of command names, not a spawn' },
];

const HARDENED_AFTER = /^\s*(\.\.\.)?hardenGitArgs\(|^\s*\[\s*\.\.\.GIT_(CLONE|READ_ONLY|SAFE_CONFIG)_ARGS\b/;
const SKIPPED_DIRS = new Set(['node_modules', 'tests', '__tests__', 'fixtures']);

function listSources(directory, found = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) listSources(full, found);
    } else if (/\.(c|m)?(js|ts)$/.test(entry.name) && !/\.test\.|\.d\.ts$|test-git-project/.test(entry.name)) {
      found.push(path.relative(REPO_ROOT, full));
    }
  }
  return found;
}

/** Every `'git',` argument occurrence that is neither hardened nor allowlisted. */
function scan(entries) {
  const unhardened = [];
  const used = new Set();
  for (const { file, source } of entries) {
    for (const match of source.matchAll(/['"]git['"]\s*,/g)) {
      const after = source.slice(match.index + match[0].length, match.index + match[0].length + 80);
      if (HARDENED_AFTER.test(after)) continue;
      const before = source.slice(Math.max(0, match.index - 40), match.index);
      const allowed = ALLOWED.find((entry) => entry.file === file && (!entry.before || entry.before.test(before)));
      if (allowed) {
        used.add(allowed);
        continue;
      }
      unhardened.push(`${file}:${source.slice(0, match.index).split('\n').length}`);
    }
  }
  return { unhardened, used };
}

test('every git spawn under server/ and the runtime scripts is hardened', () => {
  const files = [...listSources(path.join(REPO_ROOT, 'server')), ...RUNTIME_SCRIPTS];
  const { unhardened, used } = scan(files.map((file) => ({
    file, source: fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
  })));
  assert.deepEqual(unhardened, [], 'add hardenGitArgs()/GIT_*_ARGS from shared/git-safety.js');
  const stale = ALLOWED.filter((entry) => !used.has(entry)).map((entry) => entry.file);
  assert.deepEqual(stale, [], 'allowlist entries that no longer match anything');
});

test('git.js spawnAsync hardens every git argv it spawns', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, 'server/routes/git.js'), 'utf8');
  assert.match(source, /spawn\(command, command === 'git' \? hardenGitArgs\(args\) : args,/);
});

test('the scan catches an unhardened spawn (self-test)', () => {
  const source = [
    "spawn('git', ['status']);",
    "spawnSync('flock', ['-x', 'l', 'git', 'update-ref']);",
    "spawn('git', hardenGitArgs(['status']));",
    "spawn('git', [...GIT_CLONE_ARGS, 'clone']);",
  ].join('\n');
  assert.deepEqual(scan([{ file: 'server/probe.js', source }]).unhardened, ['server/probe.js:1', 'server/probe.js:2']);
});
