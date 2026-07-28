/**
 * provider-cage.test.ts — unit + integration coverage for the unified bwrap cage
 * (Phase 1, ultracode workshop 2026-07-14).
 *
 * Unit: the flag gate, the exemption classes (codex + HTTP-hosted vendors), the
 * bwrap argv shape (with per-user rebind), the fail-safe passthrough when no
 * bwrap resolves, and resolveBwrapPath's invariant.
 *
 * Integration (skipped gracefully when bwrap/userns is unavailable): runs a real
 * `buildCagedLaunch` argv through bwrap on an `sh` command that tries to read a
 * fake other-user tree under a temp usersRoot and `ls /run/docker.sock`, and
 * asserts both are blocked while `node` still boots — mirroring the on-disk check.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/services/isolation/provider-cage.test.ts
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { after, describe, it, mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cageEnabled,
  resolveBwrapPath,
  buildCagedLaunch,
  HTTP_HOSTED_PROVIDERS,
  CAGE_EXEMPT_PROVIDERS,
  CAGEABLE_AGENT_PROVIDERS,
} from './provider-cage.js';

// --- flag helpers -----------------------------------------------------------

const ORIGINAL_FLAG = process.env.NASSAJ_PROVIDER_CAGE;

function setCage(on: boolean): void {
  process.env.NASSAJ_PROVIDER_CAGE = on ? 'true' : 'false';
}

after(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.NASSAJ_PROVIDER_CAGE;
  else process.env.NASSAJ_PROVIDER_CAGE = ORIGINAL_FLAG;
});

// --- argv subsequence helper ------------------------------------------------

/** Index of the first contiguous occurrence of `sub` inside `arr`, or -1. */
function indexOfSubsequence(arr: string[], sub: string[]): number {
  outer: for (let i = 0; i + sub.length <= arr.length; i++) {
    for (let j = 0; j < sub.length; j++) {
      if (arr[i + j] !== sub[j]) continue outer;
    }
    return i;
  }
  return -1;
}

function assertContainsSeq(arr: string[], sub: string[]): void {
  assert.ok(
    indexOfSubsequence(arr, sub) !== -1,
    `argv must contain the contiguous sequence ${JSON.stringify(sub)}\ngot: ${JSON.stringify(arr)}`,
  );
}

// ---------------------------------------------------------------------------
// cageEnabled — the flag gate + exemption classes
// ---------------------------------------------------------------------------

describe('cageEnabled — flag gate and exemptions', () => {
  const WRAPPED = ['claude', 'gemini', 'agy', 'opencode', 'cursor', 'hermes'];

  it('returns false for every provider when the flag is off', () => {
    setCage(false);
    for (const p of [...WRAPPED, ...CAGE_EXEMPT_PROVIDERS]) {
      assert.equal(cageEnabled(p), false, `${p} must not be caged with flag off`);
    }
  });

  it('returns false when the flag is unset entirely', () => {
    delete process.env.NASSAJ_PROVIDER_CAGE;
    assert.equal(cageEnabled('claude'), false);
  });

  it('catches only in-scope local-CLI providers when the flag is on', () => {
    setCage(true);
    for (const p of WRAPPED) {
      assert.equal(cageEnabled(p), true, `${p} must be caged with flag on`);
    }
  });

  it('exempts codex (self-cages) even with the flag on', () => {
    setCage(true);
    assert.equal(cageEnabled('codex'), false);
  });

  it('exempts the HTTP-hosted vendors (no local process) even with the flag on', () => {
    setCage(true);
    for (const p of HTTP_HOSTED_PROVIDERS) {
      assert.equal(cageEnabled(p), false, `${p} is HTTP-hosted and must not be caged`);
    }
    // and the exemption set is exactly codex + the hosted vendors
    assert.deepEqual(
      [...CAGE_EXEMPT_PROVIDERS].sort(),
      ['codex', ...HTTP_HOSTED_PROVIDERS].sort(),
    );
  });

  it('never cages an empty / whitespace provider', () => {
    setCage(true);
    assert.equal(cageEnabled(''), false);
    assert.equal(cageEnabled('   '), false);
    // @ts-expect-error — defensive against nullish input at the JS boundary
    assert.equal(cageEnabled(undefined), false);
  });

  it('is case-insensitive', () => {
    setCage(true);
    assert.equal(cageEnabled('Claude'), true);
    assert.equal(cageEnabled('CODEX'), false);
    assert.equal(cageEnabled('  Gemini  '), true);
  });
});

// ---------------------------------------------------------------------------
// cageEnabled — per-mode chat/agent distinction (SL-6 / ADR-062)
// ---------------------------------------------------------------------------

describe('cageEnabled — per-mode chat/agent distinction (SL-6)', () => {
  const ALWAYS_CAGED = ['claude', 'gemini', 'agy', 'opencode', 'cursor', 'hermes'];

  it('cages the vendors that ship an agent CLI ONLY in agent mode', () => {
    setCage(true);
    for (const p of CAGEABLE_AGENT_PROVIDERS) {
      assert.equal(cageEnabled(p, 'agent'), true, `${p} agent run must be caged`);
      assert.equal(cageEnabled(p, 'chat'), false, `${p} chat run must stay exempt`);
    }
  });

  it('kimi + glm agent runs are caged; their chat/omitted runs are NOT (byte-identical to pre-SL-6)', () => {
    setCage(true);
    assert.equal(cageEnabled('kimi', 'agent'), true);
    assert.equal(cageEnabled('glm', 'agent'), true);
    // chat / unspecified mode preserves the old exempt behaviour exactly
    assert.equal(cageEnabled('kimi', 'chat'), false);
    assert.equal(cageEnabled('kimi'), false, 'omitted mode must equal the pre-SL-6 exempt behaviour');
    assert.equal(cageEnabled('glm'), false);
  });

  it('deepseek stays exempt even in agent mode (no agent CLI to sandbox)', () => {
    setCage(true);
    assert.equal(cageEnabled('deepseek', 'agent'), false);
    assert.equal(cageEnabled('deepseek', 'chat'), false);
    // and it is intentionally NOT in the cageable-agent set
    assert.equal(CAGEABLE_AGENT_PROVIDERS.has('deepseek'), false);
  });

  it('codex stays exempt in every mode (it self-cages via config-injection)', () => {
    setCage(true);
    assert.equal(cageEnabled('codex', 'agent'), false);
    assert.equal(cageEnabled('codex', 'chat'), false);
  });

  it('agent mode does NOT change the always-caged local-CLI providers', () => {
    setCage(true);
    for (const p of ALWAYS_CAGED) {
      assert.equal(cageEnabled(p, 'agent'), true, `${p} caged in agent mode`);
      assert.equal(cageEnabled(p, 'chat'), true, `${p} caged in chat mode too`);
    }
  });

  it('mode is case-insensitive and trims whitespace', () => {
    setCage(true);
    assert.equal(cageEnabled('kimi', 'AGENT'), true);
    assert.equal(cageEnabled('kimi', '  agent  '), true);
    assert.equal(cageEnabled('kimi', 'Agent'), true);
  });

  it('an unrecognized mode falls back to the static exempt behaviour', () => {
    setCage(true);
    assert.equal(cageEnabled('kimi', 'weird'), false, 'only agent un-exempts');
    assert.equal(cageEnabled('claude', 'weird'), true, 'a non-hosted provider is unaffected by mode');
  });

  it('the flag still gates everything: agent mode is never caged with the flag off', () => {
    setCage(false);
    assert.equal(cageEnabled('kimi', 'agent'), false);
    assert.equal(cageEnabled('glm', 'agent'), false);
  });
});

// ---------------------------------------------------------------------------
// resolveBwrapPath — invariant
// ---------------------------------------------------------------------------

describe('resolveBwrapPath', () => {
  it('returns null or a real executable file named bwrap', () => {
    const p = resolveBwrapPath();
    assert.ok(
      p === null || (typeof p === 'string' && path.basename(p) === 'bwrap'),
      `expected null or a .../bwrap path, got ${String(p)}`,
    );
    if (p !== null) {
      assert.ok(fs.statSync(p).isFile(), 'resolved bwrap must be a real file');
      assert.doesNotThrow(() => fs.accessSync(p, fs.constants.X_OK), 'must be executable');
    }
  });
});

// ---------------------------------------------------------------------------
// buildCagedLaunch — passthrough vs wrap (argv shape via an injected resolver so
// the UNIT tests do not depend on bwrap being installed).
// ---------------------------------------------------------------------------

describe('buildCagedLaunch — passthrough branches', () => {
  const FAKE = { resolveBwrapPath: () => '/opt/codex/bwrap' };

  it('passes through unchanged when the flag is off', () => {
    setCage(false);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'claude', cmd: 'claude', args: ['chat'], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(out, { cmd: 'claude', args: ['chat'] });
  });

  it('passes through codex (exempt) even with the flag on', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'codex', cmd: 'codex', args: ['exec'], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(out, { cmd: 'codex', args: ['exec'] });
    assert.notEqual(out.cmd, '/opt/codex/bwrap');
  });

  it('passes through an HTTP-hosted vendor (kimi) even with the flag on', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'kimi', cmd: 'kimi', args: [], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(out, { cmd: 'kimi', args: [] });
  });

  it('FAILS SAFE (passthrough) + warns on EVERY spawn when the flag is on but no bwrap resolves', () => {
    setCage(true);
    const warn = mock.method(console, 'warn', () => {});
    const call = () =>
      buildCagedLaunch(
        { userId: '1', provider: 'claude', cmd: 'claude', args: ['chat'], cwd: '/w', usersRoot: '/u' },
        { resolveBwrapPath: () => null },
      );
    const a = call();
    const b = call();
    const c = call();
    // never blocked — always passthrough
    for (const out of [a, b, c]) {
      assert.deepEqual(out, { cmd: 'claude', args: ['chat'] }, 'must run unwrapped, not blocked');
    }
    // NOT deduplicated: a dropped isolation layer must shout on each spawn
    assert.equal(warn.mock.callCount(), 3, 'must warn once PER spawn about the dropped cage');
    warn.mock.restore();
  });
});

describe('buildCagedLaunch — wrapped argv shape', () => {
  const FAKE = { resolveBwrapPath: () => '/opt/codex/bwrap' };
  const usersRoot = '/srv/nassaj-users';
  const cwd = '/home/dev/Project/demo';

  it('wraps an in-scope provider in bwrap with the unified flags + per-user rebind', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: ['chat', '--foo'], cwd, usersRoot },
      FAKE,
    );

    // cmd becomes bwrap; the provider command is pushed after the `--` separator.
    assert.equal(out.cmd, '/opt/codex/bwrap');

    // namespace + filesystem flags
    assertContainsSeq(out.args, ['--unshare-user', '--unshare-pid', '--unshare-ipc']);
    assertContainsSeq(out.args, ['--ro-bind', '/', '/']);
    assertContainsSeq(out.args, ['--dev', '/dev']);
    assertContainsSeq(out.args, ['--proc', '/proc']);
    assertContainsSeq(out.args, ['--tmpfs', '/run']);
    assertContainsSeq(out.args, ['--tmpfs', '/tmp']);

    // per-user isolation: hide the whole users root, re-expose only user 77's dir
    const userDir = path.join(usersRoot, '77');
    assertContainsSeq(out.args, ['--tmpfs', usersRoot]);
    assertContainsSeq(out.args, ['--bind', userDir, userDir]);

    // writable cwd
    assertContainsSeq(out.args, ['--bind', cwd, cwd]);

    // the real command sits after the separator, intact
    const dash = out.args.indexOf('--');
    assert.notEqual(dash, -1, 'a `--` separator must precede the wrapped command');
    assert.deepEqual(out.args.slice(dash + 1), ['claude', 'chat', '--foo']);

    // tmpfs-usersRoot must come BEFORE its own-dir rebind (re-expose on top)
    const tmpfsUsersIdx = indexOfSubsequence(out.args, ['--tmpfs', usersRoot]);
    const bindUserIdx = indexOfSubsequence(out.args, ['--bind', userDir, userDir]);
    assert.ok(tmpfsUsersIdx < bindUserIdx, 'must tmpfs usersRoot before rebinding the user dir');
  });

  it('rebinds the correct (distinct) userId per call — no cross-user path', () => {
    setCage(true);
    const a = buildCagedLaunch(
      { userId: '1001', provider: 'gemini', cmd: 'gemini', cwd, usersRoot },
      FAKE,
    );
    const b = buildCagedLaunch(
      { userId: '1002', provider: 'gemini', cmd: 'gemini', cwd, usersRoot },
      FAKE,
    );
    const dirA = path.join(usersRoot, '1001');
    const dirB = path.join(usersRoot, '1002');
    assertContainsSeq(a.args, ['--bind', dirA, dirA]);
    assertContainsSeq(b.args, ['--bind', dirB, dirB]);
    assert.equal(indexOfSubsequence(a.args, ['--bind', dirB, dirB]), -1, 'user A must not see B');
  });

  it('blanks each hidePaths entry with its own --tmpfs (owner-secret hiding)', () => {
    setCage(true);
    const ssh = '/home/dev/.ssh';
    const aws = '/home/dev/.aws';
    const out = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot, hidePaths: [ssh, aws] },
      FAKE,
    );
    assertContainsSeq(out.args, ['--tmpfs', ssh]);
    assertContainsSeq(out.args, ['--tmpfs', aws]);
  });

  it('orders every hidePaths tmpfs BEFORE the per-user rebind (re-expose on top)', () => {
    setCage(true);
    const ssh = '/home/dev/.ssh';
    const out = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot, hidePaths: [ssh] },
      FAKE,
    );
    const hideIdx = indexOfSubsequence(out.args, ['--tmpfs', ssh]);
    const userDir = path.join(usersRoot, '77');
    const bindUserIdx = indexOfSubsequence(out.args, ['--bind', userDir, userDir]);
    assert.ok(hideIdx !== -1 && bindUserIdx !== -1);
    assert.ok(hideIdx < bindUserIdx, 'hidePaths tmpfs must precede the user rebind');
  });

  it('ignores empty entries and adds nothing when hidePaths is omitted', () => {
    setCage(true);
    const withEmpty = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot, hidePaths: ['', undefined as unknown as string] },
      FAKE,
    );
    // no stray --tmpfs '' pair
    assert.equal(indexOfSubsequence(withEmpty.args, ['--tmpfs', '']), -1);

    const omitted = buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot },
      FAKE,
    );
    // exactly the three baseline tmpfs mounts (/run, /tmp, usersRoot) — no extras
    const tmpfsCount = omitted.args.filter((a) => a === '--tmpfs').length;
    assert.equal(tmpfsCount, 3, 'baseline is /run + /tmp + usersRoot only when no hidePaths');
  });
});

// ---------------------------------------------------------------------------
// buildCagedLaunch — writePaths (shared-store rw re-binds) + maskFiles
// (credential /dev/null file-masks) — T-898
// ---------------------------------------------------------------------------

describe('buildCagedLaunch — writePaths & maskFiles argv shape (T-898)', () => {
  const FAKE = { resolveBwrapPath: () => '/opt/codex/bwrap' };
  const usersRoot = '/srv/nassaj-users';
  const cwd = '/home/dev/Project/demo';
  const store = '/home/dev/.claude/projects';
  const npmCache = '/home/dev/.npm';
  const cred = '/home/dev/.claude/.credentials.json';
  const claudeJson = '/home/dev/.claude.json';

  function launch(extra: Record<string, unknown> = {}) {
    setCage(true);
    return buildCagedLaunch(
      { userId: '77', provider: 'claude', cmd: 'claude', args: [], cwd, usersRoot, ...extra },
      FAKE,
    );
  }

  it('re-binds every writePaths entry read-write (--bind p p)', () => {
    const out = launch({ writePaths: [store, npmCache] });
    assertContainsSeq(out.args, ['--bind', store, store]);
    assertContainsSeq(out.args, ['--bind', npmCache, npmCache]);
  });

  it('masks every maskFiles entry with a read-only /dev/null bind', () => {
    const out = launch({ maskFiles: [cred, claudeJson] });
    assertContainsSeq(out.args, ['--ro-bind', '/dev/null', cred]);
    assertContainsSeq(out.args, ['--ro-bind', '/dev/null', claudeJson]);
  });

  it('mounts maskFiles LAST: after the user rebind, the cwd bind and every writePath', () => {
    const out = launch({ writePaths: [store], maskFiles: [cred] });
    const maskIdx = indexOfSubsequence(out.args, ['--ro-bind', '/dev/null', cred]);
    const userDir = path.join(usersRoot, '77');
    const rebindIdx = indexOfSubsequence(out.args, ['--bind', userDir, userDir]);
    const cwdIdx = indexOfSubsequence(out.args, ['--bind', cwd, cwd]);
    const writeIdx = indexOfSubsequence(out.args, ['--bind', store, store]);
    assert.ok(maskIdx !== -1 && rebindIdx !== -1 && cwdIdx !== -1 && writeIdx !== -1);
    assert.ok(maskIdx > rebindIdx, 'mask must mount after the per-user rebind');
    assert.ok(maskIdx > cwdIdx, 'mask must mount after the cwd bind (a $HOME-rooted cwd must not re-expose it)');
    assert.ok(maskIdx > writeIdx, 'mask must mount after every writePaths grant');
    // and still before the command separator
    assert.ok(maskIdx < out.args.indexOf('--'));
  });

  it('orders writePaths BEFORE the usersRoot tmpfs (isolation overlays win on overlap)', () => {
    const out = launch({ writePaths: [store] });
    const writeIdx = indexOfSubsequence(out.args, ['--bind', store, store]);
    const usersIdx = indexOfSubsequence(out.args, ['--tmpfs', usersRoot]);
    assert.ok(writeIdx !== -1 && usersIdx !== -1);
    assert.ok(writeIdx < usersIdx, 'writePaths must precede the usersRoot tmpfs');
  });

  it('ignores empty entries and adds no /dev/null bind when maskFiles is omitted', () => {
    const withEmpty = launch({ writePaths: ['', undefined as unknown as string], maskFiles: [''] });
    assert.equal(indexOfSubsequence(withEmpty.args, ['--bind', '', '']), -1);
    assert.equal(withEmpty.args.includes('/dev/null'), false);

    const omitted = launch({});
    assert.equal(omitted.args.includes('/dev/null'), false, 'no masks unless asked');
  });
});

// ---------------------------------------------------------------------------
// Integration — drive a REAL bwrap sandbox (skipped when unavailable)
// ---------------------------------------------------------------------------

/** bwrap present AND unprivileged userns actually usable in this environment? */
function detectCageUsable(): { usable: boolean; reason: string } {
  const bwrap = resolveBwrapPath();
  if (!bwrap) return { usable: false, reason: 'no bwrap resolved' };
  const probe = spawnSync(bwrap, ['--unshare-user', '--ro-bind', '/', '/', '--', 'true'], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    return { usable: false, reason: `userns probe failed (status=${String(probe.status)})` };
  }
  return { usable: true, reason: '' };
}

const cage = detectCageUsable();

describe('buildCagedLaunch — integration against a real bwrap sandbox', () => {
  it(
    'hides another user tree + /run/docker.sock while node boots',
    { skip: cage.usable ? false : `bwrap/userns unavailable: ${cage.reason}` },
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cage-it-'));
      try {
        const usersRoot = path.join(tmp, 'users');
        const ownDir = path.join(usersRoot, '42');
        const otherDir = path.join(usersRoot, '99');
        const otherSecret = path.join(otherDir, 'secret.txt');
        const cwd = path.join(tmp, 'project');
        const cwdFile = path.join(cwd, 'file.txt');

        fs.mkdirSync(ownDir, { recursive: true });
        fs.mkdirSync(otherDir, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });
        fs.writeFileSync(otherSecret, 'TOPSECRET');
        fs.writeFileSync(cwdFile, 'hi');

        // single-quote wrap (temp paths from mkdtemp carry no quotes/spaces)
        const q = (s: string) => `'${s}'`;
        const script = [
          `if cat ${q(otherSecret)} 2>/dev/null; then echo LEAK_OTHER; else echo BLOCKED_OTHER; fi`,
          `if ls /run/docker.sock 2>/dev/null; then echo LEAK_SOCK; else echo BLOCKED_SOCK; fi`,
          `if [ -d ${q(ownDir)} ]; then echo OWN_OK; else echo OWN_MISSING; fi`,
          `if [ -f ${q(cwdFile)} ]; then echo CWD_OK; else echo CWD_MISSING; fi`,
          `node -e 'process.stdout.write("NODE_OK\\n")' 2>/dev/null || echo NODE_FAIL`,
        ].join('\n');

        setCage(true);
        const launch = buildCagedLaunch({
          userId: '42',
          provider: 'claude', // in-scope local CLI
          cmd: 'sh',
          args: ['-c', script],
          cwd,
          usersRoot,
        });

        // the real cage must actually be applied (not a passthrough)
        assert.equal(launch.cmd, resolveBwrapPath());

        const res = spawnSync(launch.cmd, launch.args, { encoding: 'utf8' });
        const out = `${res.stdout || ''}${res.stderr || ''}`;

        assert.equal(res.status, 0, `sandbox should exit 0, got ${String(res.status)}\n${out}`);
        // other user's tree is hidden, own dir + cwd survive
        assert.match(out, /BLOCKED_OTHER/, 'another user tree must be hidden');
        assert.doesNotMatch(out, /LEAK_OTHER/);
        assert.doesNotMatch(out, /TOPSECRET/, 'the other user secret must never be readable');
        assert.match(out, /OWN_OK/, "the caller's own dir must be re-exposed");
        assert.match(out, /CWD_OK/, 'the writable cwd must be present');
        // host runtime sockets hidden
        assert.match(out, /BLOCKED_SOCK/, '/run/docker.sock must be hidden');
        assert.doesNotMatch(out, /LEAK_SOCK/);
        // the child still boots
        assert.match(out, /NODE_OK/, 'node must still boot inside the cage');
        assert.doesNotMatch(out, /NODE_FAIL/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it(
    'maskFiles blanks a credential file while writePaths stays writable and ro stays ro (T-898)',
    { skip: cage.usable ? false : `bwrap/userns unavailable: ${cage.reason}` },
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cage-mask-it-'));
      try {
        const cred = path.join(tmp, 'auth.json');
        const store = path.join(tmp, 'shared-store');
        const roDir = path.join(tmp, 'ro-dir');
        const cwd = path.join(tmp, 'project');
        fs.writeFileSync(cred, '{"token":"SECRETTOKEN"}');
        fs.mkdirSync(store, { recursive: true });
        fs.mkdirSync(roDir, { recursive: true });
        fs.mkdirSync(cwd, { recursive: true });

        const q = (s: string) => `'${s}'`;
        const script = [
          // masked credential: bound to the /dev/null device → zero-length AND
          // its content never flows (ro-bound char device denies read). Both
          // facts prove the secret is gone: -s is false and cat yields nothing.
          `if [ -s ${q(cred)} ]; then echo MASK_LEAK; else echo MASK_EMPTY; fi`,
          `cat ${q(cred)} 2>/dev/null`,
          // write into the rw-re-bound shared store must succeed
          `if echo probe > ${q(path.join(store, 'probe.txt'))} 2>/dev/null; then echo STORE_WRITE_OK; else echo STORE_WRITE_FAIL; fi`,
          // a sibling dir WITHOUT a write grant stays read-only (ro-bind /)
          `if echo probe > ${q(path.join(roDir, 'probe.txt'))} 2>/dev/null; then echo RO_LEAK; else echo RO_BLOCKED; fi`,
        ].join('\n');

        setCage(true);
        const launch = buildCagedLaunch({
          userId: null,
          provider: 'claude',
          cmd: 'sh',
          args: ['-c', script],
          cwd,
          writePaths: [store],
          maskFiles: [cred],
        });
        assert.equal(launch.cmd, resolveBwrapPath());

        const res = spawnSync(launch.cmd, launch.args, { encoding: 'utf8' });
        const out = `${res.stdout || ''}${res.stderr || ''}`;
        assert.equal(res.status, 0, `sandbox should exit 0, got ${String(res.status)}\n${out}`);
        assert.match(out, /MASK_EMPTY/, 'masked credential must read as empty');
        assert.doesNotMatch(out, /MASK_LEAK/);
        assert.doesNotMatch(out, /SECRETTOKEN/, 'the credential content must never be readable');
        assert.match(out, /STORE_WRITE_OK/, 'the rw-re-bound store must accept writes');
        assert.doesNotMatch(out, /STORE_WRITE_FAIL/);
        assert.match(out, /RO_BLOCKED/, 'an unlisted dir must stay read-only');
        assert.doesNotMatch(out, /RO_LEAK/);

        // and the write really landed on the host disk
        assert.equal(fs.readFileSync(path.join(store, 'probe.txt'), 'utf8').trim(), 'probe');
        // while the host credential is untouched
        assert.match(fs.readFileSync(cred, 'utf8'), /SECRETTOKEN/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});

// ---------------------------------------------------------------------------
// buildCagedLaunch — per-mode wrapping (SL-6): the agent run of an HTTP-hosted
// vendor is wrapped; its chat/omitted run passes through.
// ---------------------------------------------------------------------------

describe('buildCagedLaunch — per-mode (SL-6)', () => {
  const FAKE = { resolveBwrapPath: () => '/opt/codex/bwrap' };

  it('wraps a kimi AGENT launch in bwrap (mode: "agent")', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'kimi', mode: 'agent', cmd: 'kimi', args: ['-p', 'hi'], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.equal(out.cmd, '/opt/codex/bwrap');
    const dash = out.args.indexOf('--');
    assert.deepEqual(out.args.slice(dash + 1), ['kimi', '-p', 'hi'], 'the kimi command sits after the separator');
  });

  it('wraps a glm AGENT launch in bwrap (mode: "agent")', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'glm', mode: 'agent', cmd: 'opencode', args: ['run'], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.equal(out.cmd, '/opt/codex/bwrap');
  });

  it('passes through a kimi CHAT / omitted-mode launch even with the flag on', () => {
    setCage(true);
    const chat = buildCagedLaunch(
      { userId: '1', provider: 'kimi', mode: 'chat', cmd: 'kimi', args: [], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(chat, { cmd: 'kimi', args: [] });
    const omitted = buildCagedLaunch(
      { userId: '1', provider: 'kimi', cmd: 'kimi', args: [], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(omitted, { cmd: 'kimi', args: [] });
  });

  it('passes through a deepseek AGENT launch (no agent CLI ⇒ still exempt)', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '1', provider: 'deepseek', mode: 'agent', cmd: 'deepseek', args: [], cwd: '/w', usersRoot: '/u' },
      FAKE,
    );
    assert.deepEqual(out, { cmd: 'deepseek', args: [] });
  });
});

// ---------------------------------------------------------------------------
// M-3 regression guard — the cage must NEVER bake env into argv.
//
// Structural invariant (proven from the code and locked here): the bwrap argv
// carries NO `--setenv`/`--clearenv`, so the child inherits EXACTLY the env
// dict handed to spawn(bwrap, args, { env }). That is what makes the SL-3
// `sanitizeVendorAgentEnv` step effective: whatever it strips from the env dict
// is truly gone from the child. If a future edit ever adds `--setenv
// ANTHROPIC_BASE_URL …` (or `--clearenv` + a re-inject), sanitize silently
// becomes a no-op — these tests fail loudly the moment that happens.
// ---------------------------------------------------------------------------

describe('M-3 — cage never bakes env into argv (static guard)', () => {
  const FAKE = { resolveBwrapPath: () => '/opt/codex/bwrap' };
  const usersRoot = '/srv/nassaj-users';
  const cwd = '/home/dev/Project/demo';

  /** Every caged provider/mode the seam can produce — the guard must hold for all. */
  const CASES: Array<{ provider: string; mode?: string }> = [
    { provider: 'claude' },
    { provider: 'gemini' },
    { provider: 'agy' },
    { provider: 'opencode' },
    { provider: 'hermes' },
    { provider: 'kimi', mode: 'agent' },
    { provider: 'glm', mode: 'agent' },
  ];

  it('emits NO --setenv and NO --clearenv for any caged launch', () => {
    setCage(true);
    for (const { provider, mode } of CASES) {
      const out = buildCagedLaunch(
        {
          userId: '77',
          provider,
          mode,
          cmd: provider,
          args: ['run'],
          cwd,
          usersRoot,
          // even when the caller hands env-shaped strings as paths, they must
          // never turn into a --setenv directive:
          writePaths: ['/home/dev/.npm'],
          maskFiles: ['/home/dev/.claude/.credentials.json'],
        },
        FAKE,
      );
      assert.equal(out.cmd, '/opt/codex/bwrap', `${provider} must actually be caged`);
      assert.equal(out.args.includes('--setenv'), false, `${provider}: --setenv must never appear in the cage argv`);
      assert.equal(out.args.includes('--clearenv'), false, `${provider}: --clearenv must never appear in the cage argv`);
    }
  });

  it('never bakes an ANTHROPIC_*/CLAUDE_* token into the cage argv', () => {
    setCage(true);
    const out = buildCagedLaunch(
      { userId: '77', provider: 'kimi', mode: 'agent', cmd: 'kimi', args: ['-p', 'x'], cwd, usersRoot },
      FAKE,
    );
    // the ONLY argv content is bwrap flags + mount paths + the wrapped command;
    // no env name/value is ever an argv token.
    for (const tok of out.args) {
      assert.doesNotMatch(
        tok,
        /ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN/,
        `no cage argv token may carry a sanitized env name: ${tok}`,
      );
    }
  });
});

describe('M-3 — real caged child inherits ONLY the passed env (integration)', () => {
  it(
    'a kimi-agent cage leaks no ANTHROPIC_*/CLAUDE_CODE_OAUTH_TOKEN the spawn env omitted',
    { skip: cage.usable ? false : `bwrap/userns unavailable: ${cage.reason}` },
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-cage-m3-'));
      try {
        const cwd = path.join(tmp, 'project');
        fs.mkdirSync(cwd, { recursive: true });

        // A post-sanitize env: the probe var is present; the forbidden keys are
        // NOT in the dict. Because there is no --setenv/--clearenv, the child
        // must see EXACTLY this — probe present, forbidden keys absent.
        const childEnv = {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: os.homedir(),
          NASSAJ_CAGE_PROBE: 'present',
        };

        setCage(true);
        const launch = buildCagedLaunch({
          userId: null,
          provider: 'kimi',
          mode: 'agent', // agent run IS caged (SL-6)
          cmd: '/usr/bin/printenv',
          args: [],
          cwd,
        });
        assert.equal(launch.cmd, resolveBwrapPath(), 'the kimi-agent run must actually be caged');

        const res = spawnSync(launch.cmd, launch.args, { env: childEnv, encoding: 'utf8' });
        const out = `${res.stdout || ''}`;
        assert.equal(res.status, 0, `caged printenv should exit 0, got ${String(res.status)}\n${res.stderr}`);
        // env passed through the cage transparently …
        assert.match(out, /^NASSAJ_CAGE_PROBE=present$/m, 'the passed env must reach the child');
        // … and nothing re-introduced the sanitized keys via argv
        assert.doesNotMatch(out, /^ANTHROPIC_/m, 'no ANTHROPIC_* may appear in the caged child env');
        assert.doesNotMatch(out, /^CLAUDE_CODE_OAUTH_TOKEN=/m, 'the Claude OAuth token must never reach the caged child');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );

  it(
    'counterfactual: a --setenv-baked argv WOULD leak — proving the guard has teeth',
    { skip: cage.usable ? false : `bwrap/userns unavailable: ${cage.reason}` },
    () => {
      // This is NOT what the cage builds; it hand-forges the exact regression M-3
      // forbids (bwrap … --setenv ANTHROPIC_BASE_URL … -- printenv) to prove the
      // leak is real, so the static guard above is meaningful rather than vacuous.
      const bwrap = resolveBwrapPath();
      assert.ok(bwrap, 'bwrap must resolve for this integration');
      const forged = [
        '--unshare-user',
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc',
        '--setenv', 'ANTHROPIC_BASE_URL', 'https://evil.example',
        '--', '/usr/bin/printenv',
      ];
      const res = spawnSync(bwrap as string, forged, {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, // note: NOT in spawn env
        encoding: 'utf8',
      });
      assert.equal(res.status, 0, res.stderr);
      assert.match(
        `${res.stdout}`,
        /^ANTHROPIC_BASE_URL=https:\/\/evil\.example$/m,
        '--setenv DOES bake env past a sanitized spawn env — which is exactly why the cage must never use it',
      );
    },
  );
});
