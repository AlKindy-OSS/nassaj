/**
 * B-1689 — unit contract of the session file-root resolver and path rebasing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOverlayFileWriteAuditEntry,
  parseSessionIdParam,
  rebaseRequestedPath,
  resolveSessionFileRoot,
} from './session-file-root.js';

const ROOT = '/srv/app';
const OVERLAY = '/srv/app/.git/nassaj-session-overlays/instances/abc/workspace';

function resolve(overrides = {}) {
  const calls = [];
  const result = resolveSessionFileRoot({
    projectRoot: ROOT,
    sessionId: 's1',
    userId: 3,
    mode: 'read',
    getSessionById: (id) => (id === 's1' ? { session_id: 's1', project_path: ROOT } : null),
    isSessionAccessible: (...args) => { calls.push(args); return true; },
    findOverlay: () => ({ cwd: OVERLAY, overlayId: 'abc' }),
    ...overrides,
  });
  return { result, calls };
}

test('parseSessionIdParam accepts absent and well-formed ids only', () => {
  for (const raw of [undefined, null, '']) assert.deepEqual(parseSessionIdParam(raw), { ok: true, sessionId: null });
  assert.deepEqual(parseSessionIdParam('5e7ec8b5-924c-4368'), { ok: true, sessionId: '5e7ec8b5-924c-4368' });
  for (const raw of ['../x', 'a/b', 'a b', ['s1'], 42, 'x'.repeat(201)]) {
    assert.deepEqual(parseSessionIdParam(raw), { ok: false }, String(raw));
  }
});

test('resolveSessionFileRoot picks the overlay only for an authorized session of this project', () => {
  const { result, calls } = resolve();
  assert.deepEqual(result, { ok: true, root: OVERLAY, overlay: true, sessionId: 's1', overlayId: 'abc' });
  assert.deepEqual(calls, [['s1', ROOT, 3, 'read']]);

  assert.deepEqual(resolve({ sessionId: undefined }).result,
    { ok: true, root: ROOT, overlay: false, sessionId: null, overlayId: null });
  assert.deepEqual(resolve({ findOverlay: () => null }).result,
    { ok: true, root: ROOT, overlay: false, sessionId: 's1', overlayId: null });
  assert.deepEqual(resolve({ sessionId: 'bad/id' }).result, { ok: false, status: 400 });
  assert.deepEqual(resolve({ sessionId: 'nope' }).result, { ok: false, status: 404 });
  assert.deepEqual(resolve({ isSessionAccessible: () => false }).result, { ok: false, status: 404 });
  assert.deepEqual(resolve({ findOverlay: () => { throw new Error('malformed'); } }).result,
    { ok: false, status: 404 });
  assert.deepEqual(resolve({ getSessionById: () => ({ session_id: 's1', project_path: '/srv/other' }) }).result,
    { ok: false, status: 404 }, 'a session of another project');
  assert.deepEqual(resolve({ getSessionById: () => ({ session_id: 'S1', project_path: ROOT }) }).result,
    { ok: false, status: 404 }, 'the row must be the exact session');
});

test('rebaseRequestedPath moves project-root absolute paths into the overlay only', () => {
  assert.equal(rebaseRequestedPath('docs/a.md', ROOT, OVERLAY), 'docs/a.md');
  assert.equal(rebaseRequestedPath('/srv/app/docs/a.md', ROOT, OVERLAY), `${OVERLAY}/docs/a.md`);
  assert.equal(rebaseRequestedPath(`${OVERLAY}/docs/a.md`, ROOT, OVERLAY), `${OVERLAY}/docs/a.md`);
  assert.equal(rebaseRequestedPath('/etc/passwd', ROOT, OVERLAY), '/etc/passwd', 'left for the guard to refuse');
  assert.equal(rebaseRequestedPath('/srv/application/x', ROOT, OVERLAY), '/srv/application/x');
  assert.equal(rebaseRequestedPath('/srv/app/docs/a.md', ROOT, ROOT), '/srv/app/docs/a.md');
});

test('buildOverlayFileWriteAuditEntry records who, where and the overlay-relative path only', () => {
  const entry = buildOverlayFileWriteAuditEntry({ ip: '10.0.0.1', get: () => 'ua' }, {
    userId: 3, projectId: 42, scope: { root: OVERLAY, sessionId: 's1', overlayId: 'abc' },
    absolutePath: `${OVERLAY}/docs/a.md`,
  });
  assert.deepEqual(entry, {
    userId: 3, ipAddress: '10.0.0.1', userAgent: 'ua',
    metadata: { projectId: '42', sessionId: 's1', overlayId: 'abc', path: 'docs/a.md' },
  });
});
