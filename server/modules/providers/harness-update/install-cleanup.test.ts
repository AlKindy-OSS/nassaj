/**
 * install-cleanup.test — ADR-215 ش5: the hard deny-list and the
 * lstat + unlink cleanup bounds (never recursive, never a symlink or dir,
 * never a pre-existing, foreign or older-than-job file).
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import {
  CLEANUP_DENY_LIST,
  existingOwnedPaths,
  isDeniedCleanupPath,
  removeAppearedOwnedPaths,
} from './install-cleanup.js';
import { HARNESS_INSTALL_SOURCES } from './install-sources.js';

const HOME = fs.mkdtempSync(path.join('/var/tmp', 'install-cleanup-test-'));
after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const at = (rel: string) => path.join(HOME, rel);
function put(rel: string, body = 'x'): string {
  fs.mkdirSync(path.dirname(at(rel)), { recursive: true });
  fs.writeFileSync(at(rel), body);
  return at(rel);
}

const DENIED = [
  '.gemini', '.gemini/oauth_creds.json', '.gemini/antigravity-cli/brain/x',
  '.local/bin/gemini',
  '.claude', '.claude/settings.json', '.claude.json', '.claude-alt/x', '.claudeX',
  '.local/share/claude', '.local/share/claude/versions', '.local/share/claude/versions/latest',
  '.local/share/claude/versions/2.1.304/x', '.local/share/claude/versions/2.1', '.local/share/claude/other/2.1.304',
  '.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zprofile', '.zshenv',
  '.config/fish/config.fish',
];

test('ش5 deny-list: every denied path (and anything below it) is refused', () => {
  for (const rel of DENIED) assert.equal(isDeniedCleanupPath(at(rel), HOME), true, rel);
  for (const rel of CLEANUP_DENY_LIST) assert.equal(isDeniedCleanupPath(at(rel), HOME), true, rel);
});

test('ش5 deny-list: HOME itself, paths outside it, traversal and relative paths are refused', () => {
  for (const p of [HOME, '/etc/passwd', path.join(HOME, '..', 'other'), at('.local/../../x'), '.local/bin/agy']) {
    assert.equal(isDeniedCleanupPath(p, HOME), true, p);
  }
  assert.equal(isDeniedCleanupPath(at('.local/bin/agy'), 'relative-home'), true);
});

test('ش5 deny-list: the vendor files a descriptor owns are allowed', () => {
  for (const rel of ['.local/bin/agy', '.cache/antigravity/staging/agy.tar.gz', '.local/bin/geminix',
    '.local/bin/claude', '.local/share/claude/versions/2.1.304']) {
    assert.equal(isDeniedCleanupPath(at(rel), HOME), false, rel);
  }
});

test('ش5: no descriptor declares an owned path the deny-list refuses', () => {
  for (const [id, source] of Object.entries(HARNESS_INSTALL_SOURCES)) {
    if (source.kind === 'asset') continue;
    const ownedList = source.kind === 'script' ? source.ownedPaths(HOME) : source.ownedPaths(HOME, '2.1.304');
    for (const owned of ownedList) {
      assert.equal(isDeniedCleanupPath(owned.path, HOME), false, `${id}: ${owned.path}`);
    }
  }
});

test('ش5: a denied path listed as owned and created during the job is left in place', () => {
  const dirs = ['.gemini', '.claude', '.local/share/claude', '.local/share/claude/versions', '.local/share/claude/versions/2.1.304'];
  const owned = DENIED.filter((rel) => !dirs.includes(rel))
    .map((rel) => ({ path: at(rel), staging: false }));
  const before = existingOwnedPaths(owned);
  for (const o of owned) put(path.relative(HOME, o.path));
  const res = removeAppearedOwnedPaths(owned, before, { home: HOME, sinceMs: Date.now(), stagingOnly: false });
  assert.deepEqual(res.removed, []);
  assert.equal(res.skipped.length, owned.length);
  assert.ok(res.skipped.every((s) => s.reason === 'denied'));
  for (const o of owned) assert.ok(fs.existsSync(o.path), o.path);
});

test('cleanup bounds: removes appeared regular files (even with an archive mtime); dirs, symlinks, pre-existing stay', () => {
  const rels = ['a/new', 'a/pre', 'a/dir', 'a/link', 'a/tarred', 'a/never'];
  const owned = rels.map((rel) => ({ path: at(rel), staging: false }));
  put('a/pre', 'pre');
  const before = existingOwnedPaths(owned);
  assert.deepEqual([...before], [at('a/pre')]);
  const since = Date.now();
  put('a/new');
  fs.mkdirSync(at('a/dir'));
  put('a/dir/child');
  put('a/target', 'keep');
  fs.symlinkSync(at('a/target'), at('a/link'));
  // F1: tar keeps the archive's mtime; the new inode's ctime is still "now".
  put('a/tarred');
  const archived = new Date(since - 24 * 60 * 60 * 1000);
  fs.utimesSync(at('a/tarred'), archived, archived);
  const res = removeAppearedOwnedPaths(owned, before, { home: HOME, sinceMs: since, stagingOnly: false });
  assert.deepEqual(res.removed, [at('a/new'), at('a/tarred')]);
  assert.deepEqual(res.skipped.map((s) => `${path.basename(s.path)}:${s.reason}`), ['dir:not-a-file', 'link:symlink']);
  assert.ok(fs.existsSync(at('a/pre')) && fs.existsSync(at('a/dir/child')) && fs.existsSync(at('a/target')));
});

test('cleanup bounds: a file whose inode predates the job is older-than-job and stays', () => {
  const owned = [{ path: put('o/file'), staging: false }];
  const res = removeAppearedOwnedPaths(owned, new Set(), { home: HOME, sinceMs: Date.now() + 60_000, stagingOnly: false });
  assert.deepEqual(res.skipped.map((s) => s.reason), ['older-than-job']);
  assert.ok(fs.existsSync(at('o/file')));
});

test('ش5 realpath: an owned path whose parent is a symlink into ~/.gemini is denied', () => {
  fs.mkdirSync(at('.gemini/bin'), { recursive: true });
  fs.mkdirSync(at('r/.local'), { recursive: true });
  fs.symlinkSync(at('.gemini/bin'), at('r/.local/bin'));
  const owned = [{ path: at('r/.local/bin/agy'), staging: false }];
  const before = existingOwnedPaths(owned);
  fs.writeFileSync(at('.gemini/bin/agy'), 'creds-adjacent');
  const res = removeAppearedOwnedPaths(owned, before, { home: HOME, sinceMs: Date.now(), stagingOnly: false });
  assert.deepEqual(res.skipped.map((s) => s.reason), ['denied']);
  assert.ok(fs.existsSync(at('.gemini/bin/agy')));
});

test('cleanup stagingOnly: the success path removes staging leftovers but keeps the binary', () => {
  const owned = [{ path: at('s/bin'), staging: false }, { path: at('s/payload'), staging: true }];
  const before = existingOwnedPaths(owned);
  put('s/bin');
  put('s/payload');
  const res = removeAppearedOwnedPaths(owned, before, { home: HOME, sinceMs: Date.now(), stagingOnly: true });
  assert.deepEqual(res.removed, [at('s/payload')]);
  assert.ok(fs.existsSync(at('s/bin')));
});

test('launcher symlink: removed only when its literal target is the declared version file', () => {
  const target = put('l/versions/2.1.304');
  const owned = [{ path: at('l/bin/claude'), staging: false, symlinkTo: target }];
  for (const [link, removed] of [[target, true], [`${HOME}/l/versions/../versions/2.1.304`, false], [at('l/other'), false]] as const) {
    fs.rmSync(at('l/bin'), { recursive: true, force: true });
    const before = existingOwnedPaths(owned);
    fs.mkdirSync(at('l/bin'), { recursive: true });
    fs.symlinkSync(link, at('l/bin/claude'));
    const res = removeAppearedOwnedPaths(owned, before, { home: HOME, sinceMs: Date.now(), stagingOnly: false });
    assert.equal(res.removed.length === 1, removed, link);
    if (!removed) assert.deepEqual(res.skipped.map((s) => s.reason), ['symlink']);
  }
  fs.rmSync(at('l/bin'), { recursive: true, force: true });
  const before = existingOwnedPaths(owned);
  put('l/bin/claude');
  const res = removeAppearedOwnedPaths(owned, before, { home: HOME, sinceMs: Date.now(), stagingOnly: false });
  assert.deepEqual(res.skipped.map((s) => s.reason), ['not-a-file'], 'a regular file where a link is declared stays');
});
