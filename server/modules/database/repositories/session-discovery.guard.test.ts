import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ADR-201 A2 guard: every production writer of discovered sessions goes through
 * insertDiscoveredSession / refreshDiscoveredSession / recordDiscoveredSession.
 * A direct `sessionsDb.createSession` call (the old unconditional upsert, now a
 * test-fixture alias) outside the sessions repository fails this test.
 */

const serverRoot = fileURLToPath(new URL('../../..', import.meta.url));
const REPOSITORY_FILES = new Set([
  'modules/database/repositories/sessions.db.ts',
  'modules/database/repositories/session-discovery.db.ts',
]);
const DIRECT_CALL = /\bsessionsDb\s*(?:\?\.|\.)\s*createSession\b|\bsessionsDb\s*\[\s*['"`]createSession['"`]\s*\]/;
const DESTRUCTURED = /\{[^}]*\bcreateSession\b[^}]*\}\s*=\s*sessionsDb\b/;

function isTestFile(relative: string): boolean {
  return /\.test\.[cm]?[jt]sx?$/.test(relative) || relative.split(path.sep).includes('__tests__');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.[cm]?[jt]s$/.test(entry.name) ? [full] : [];
  });
}

/** Non-test files under server/ that call sessionsDb.createSession directly. */
function findDirectCreateSessionCallers(root: string = serverRoot): string[] {
  return sourceFiles(root)
    .map((file) => path.relative(root, file))
    .filter((relative) => !isTestFile(relative) && !REPOSITORY_FILES.has(relative))
    .filter((relative) => {
      const source = readFileSync(path.join(root, relative), 'utf8');
      return DIRECT_CALL.test(source) || DESTRUCTURED.test(source);
    })
    .sort();
}

test('no production code calls sessionsDb.createSession outside the repository', () => {
  assert.deepEqual(findDirectCreateSessionCallers(), []);
});

test('the guard pattern catches each call spelling it is meant to forbid', () => {
  for (const spelling of [
    'sessionsDb.createSession(id, p, c)',
    'sessionsDb?.createSession(id)',
    'sessionsDb\n  .createSession(id)',
    "sessionsDb['createSession'](id)",
  ]) {
    assert.ok(DIRECT_CALL.test(spelling), spelling);
  }
  assert.ok(DESTRUCTURED.test('const { createSession } = sessionsDb;'));
  assert.equal(DIRECT_CALL.test('sessionManager.createSession(id, cwd)'), false);
  assert.equal(DIRECT_CALL.test('sessionsDb.recordDiscoveredSession({ sessionId })'), false);
});
