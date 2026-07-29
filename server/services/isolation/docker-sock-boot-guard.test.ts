/**
 * docker-sock-boot-guard.test.ts — T-896 fail-closed boot guard.
 *
 * Unit: absence pass, non-member pass, membership refusal (supplementary AND
 * primary/effective gid), numeric-only matching, fail-closed on unverifiable
 * states, remediation content of the fatal message.
 *
 * Integration (real host): the guard's verdict on the LIVE process must equal
 * ground truth computed independently from fs.statSync + process gids. On the
 * current fleet node (degroup applied 2026-07-14) that means: docker.sock
 * present, process without gid 989 → the guard PASSES, i.e. the next restart
 * of nassaj-dev is NOT broken by this guard.
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/services/isolation/docker-sock-boot-guard.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';

import {
  DOCKER_SOCK_PATH,
  DockerSockExposedError,
  enforceDockerSockBootGuard,
} from './docker-sock-boot-guard.js';

/** Builds injectable deps with quiet logging and simple fakes. */
function makeDeps(overrides: Record<string, unknown> = {}) {
  const errors: string[] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  const recorded: Record<string, unknown>[] = [];
  return {
    errors,
    warns,
    infos,
    recorded,
    deps: {
      sockPath: '/var/run/docker.sock',
      statSync: () => ({ gid: 989 }) as fs.Stats,
      getgroups: () => [24, 27, 100, 1000],
      getgid: () => 1000,
      getegid: () => 1000,
      shared: true,
      logError: (m: string) => errors.push(m),
      logWarn: (m: string) => warns.push(m),
      logInfo: (m: string) => infos.push(m),
      recordWarning: (w: Record<string, unknown>) => recorded.push(w),
      ...overrides,
    },
  };
}

function enoent(): never {
  const err = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  throw err;
}

describe('enforceDockerSockBootGuard — pass paths', () => {
  it('passes SILENTLY when the socket is absent (ENOENT)', () => {
    const { deps, errors, infos } = makeDeps({ statSync: enoent });
    const res = enforceDockerSockBootGuard(deps);
    assert.deepEqual(res, { checked: false, exposed: false, verified: true, enforced: true, sockGid: null });
    assert.equal(errors.length, 0);
    assert.equal(infos.length, 0, 'absence must not even log (silent pass per spec)');
  });

  it('passes when the socket exists but no process gid matches its owner', () => {
    const { deps, errors } = makeDeps();
    const res = enforceDockerSockBootGuard(deps);
    assert.deepEqual(res, { checked: true, exposed: false, verified: true, enforced: true, sockGid: 989 });
    assert.equal(errors.length, 0);
  });
});

describe('enforceDockerSockBootGuard — refusal paths (fail-closed)', () => {
  it('throws when the socket gid is among the SUPPLEMENTARY groups', () => {
    const { deps, errors } = makeDeps({ getgroups: () => [24, 989, 1000] });
    assert.throws(() => enforceDockerSockBootGuard(deps), DockerSockExposedError);
    assert.equal(errors.length, 1, 'must log the operational fatal message once');
  });

  it('throws when the socket gid is the PRIMARY gid even if getgroups omits it', () => {
    // POSIX does not guarantee getgroups() contains the (real/effective) gid;
    // a docker PRIMARY group grants the same access and must be caught.
    const { deps } = makeDeps({
      getgroups: () => [24, 1000],
      getgid: () => 989,
      getegid: () => 989,
    });
    assert.throws(() => enforceDockerSockBootGuard(deps), DockerSockExposedError);
  });

  it('matches NUMERICALLY: an unnamed gid (post groupdel) is still caught', () => {
    // No name resolution anywhere: a socket owned by raw gid 63321 with no
    // /etc/group entry must still refuse when the process holds 63321.
    const { deps } = makeDeps({
      statSync: () => ({ gid: 63321 }) as fs.Stats,
      getgroups: () => [63321],
    });
    assert.throws(() => enforceDockerSockBootGuard(deps), DockerSockExposedError);
  });

  it('fails CLOSED on an unexpected stat error (present but unverifiable)', () => {
    const { deps } = makeDeps({
      statSync: () => {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    });
    assert.throws(() => enforceDockerSockBootGuard(deps), DockerSockExposedError);
  });

  it('fails CLOSED when the platform cannot report groups while the socket exists', () => {
    // `null` models a platform where the group API is missing (non-function
    // branch), exactly like production would. The guard falls back to the LIVE
    // process functions ONLY when the key is OMITTED entirely — an explicitly
    // passed value (null OR undefined, see the next case) is honored verbatim.
    const { deps } = makeDeps({ getgroups: null, getgid: null, getegid: null });
    assert.throws(() => enforceDockerSockBootGuard(deps), DockerSockExposedError);
  });

  it('fails CLOSED when getgroups is explicitly undefined (testability fix, qa-critic 2026-07-15)', () => {
    // The old `getgroups = process.getgroups` parameter default silently reverted an
    // explicit `undefined` to the REAL function, so absence could only be simulated
    // with `null`. Now an explicitly-passed `undefined` is honored as "no getgroups"
    // and still fails closed — while OMITTING the key keeps the live default.
    const { deps } = makeDeps({ getgroups: undefined });
    assert.throws(() => enforceDockerSockBootGuard(deps), DockerSockExposedError);
  });

  it('carries the full remediation in the thrown message (gpasswd, clean shell, pm2 kill)', () => {
    const { deps } = makeDeps({ getgroups: () => [989] });
    try {
      enforceDockerSockBootGuard(deps);
      assert.fail('must have thrown');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /gpasswd -d \S+ docker/);
      assert.match(msg, /su - \S+/);
      assert.match(msg, /pm2 kill && pm2 resurrect/);
      assert.match(msg, /pm2 restart.*NOT enough/i);
      assert.match(msg, /NASSAJ_SECURITY_POSTURE=strict selects it/);
      // a PROVEN exposure is not the unverifiable case — no mixed message
      assert.doesNotMatch(msg, /UNVERIFIABLE/);
    }
  });
});

describe('enforceDockerSockBootGuard — unverifiable message is DISTINCT (qa-critic 2026-07-14)', () => {
  // The degroup steps (gpasswd/su/pm2 kill) treat a held gid; on a stat failure
  // they are the wrong medicine and would mislead the operator. Both paths stay
  // fail-closed — only the diagnosis differs.

  it('stat EACCES: message says UNVERIFIABLE + host-FS diagnosis, NOT the gpasswd degroup steps', () => {
    const { deps, errors } = makeDeps({
      statSync: () => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    });
    try {
      enforceDockerSockBootGuard(deps);
      assert.fail('must have thrown (fail-closed)');
    } catch (err) {
      assert.ok(err instanceof DockerSockExposedError, 'must still refuse to boot');
      const msg = (err as Error).message;
      assert.match(msg, /UNVERIFIABLE/);
      assert.match(msg, /NOT a proven docker-group exposure/i);
      assert.match(msg, /stat \/var\/run\/docker\.sock/, 'must point at reproducing the syscall');
      assert.match(msg, /ls -ld \/var \/var\/run \/run/, 'must point at the path chain');
      assert.doesNotMatch(msg, /gpasswd/, 'degroup steps are the wrong medicine for a stat failure');
      assert.doesNotMatch(msg, /pm2 kill/);
      // the documented trade-off + the no-flag invariant stay explicit
      assert.match(msg, /fail-closed BY DESIGN on untrusted-user instances/i);
      assert.match(msg, /NASSAJ_SECURITY_POSTURE=strict selects it/);
      assert.equal(errors.length, 1);
    }
  });

  it('platform without getgroups: same UNVERIFIABLE form, still fail-closed', () => {
    const { deps } = makeDeps({ getgroups: null, getgid: null, getegid: null });
    try {
      enforceDockerSockBootGuard(deps);
      assert.fail('must have thrown (fail-closed)');
    } catch (err) {
      const msg = (err as Error).message;
      assert.match(msg, /UNVERIFIABLE/);
      assert.match(msg, /cannot report process groups/);
      assert.doesNotMatch(msg, /gpasswd/);
    }
  });
});

describe('enforceDockerSockBootGuard — LIVE host integration', () => {
  it('verdict on the real process equals independently-computed ground truth', () => {
    // Ground truth, computed WITHOUT the guard: does the live process hold the
    // real socket's owning gid?
    let sockGid: number | null = null;
    try {
      sockGid = fs.statSync(DOCKER_SOCK_PATH).gid;
    } catch {
      sockGid = null; // no socket on this machine
    }
    const liveGids = new Set<number>([
      ...(typeof process.getgroups === 'function' ? process.getgroups() : []),
      ...(typeof process.getgid === 'function' ? [process.getgid()] : []),
      ...(typeof process.getegid === 'function' ? [process.getegid()] : []),
    ]);
    const trulyExposed = sockGid !== null && liveGids.has(sockGid);

    const quiet = { logError: () => {}, logInfo: () => {} };
    if (trulyExposed) {
      assert.throws(() => enforceDockerSockBootGuard(quiet), DockerSockExposedError);
    } else {
      // On nassaj-dev post-degroup (2026-07-14) THIS branch must run: the
      // socket exists (gid 989) and the process does not hold it — proving the
      // guard will not break the next live restart.
      const res = enforceDockerSockBootGuard(quiet);
      assert.equal(res.exposed, false);
      if (sockGid !== null) {
        assert.equal(res.checked, true);
        assert.equal(res.sockGid, sockGid);
      }
    }
  });
});

describe('enforceDockerSockBootGuard — trusted posture degrades to a warning (T-1085)', () => {
  // Scope narrowing, owner decision 2026-07-29: when the accounts on an instance
  // are operators of the host, refusing to boot protects nobody — they can run
  // `docker run -v /:/host` from their own shell already. The FINDING is
  // unchanged; only the ACTION is.

  it('boots (no throw) on a proven exposure and reports enforced:false', () => {
    const { deps, errors, warns } = makeDeps({
      shared: false,
      postureReason: 'default posture: accounts are operators of this host',
      getgroups: () => [24, 989, 1000],
    });
    const res = enforceDockerSockBootGuard(deps);
    assert.deepEqual(res, {
      checked: true,
      exposed: true,
      verified: true,
      enforced: false,
      sockGid: 989,
    });
    assert.equal(errors.length, 0, 'a degraded verdict must not log as a fatal error');
    assert.equal(warns.length, 1);
    assert.match(warns[0], /BOOTING ANYWAY \(trusted-operator posture\)/);
    // the full diagnosis + remediation still reach the operator verbatim
    assert.match(warns[0], /REFUSING TO BOOT/);
    assert.match(warns[0], /gpasswd -d \S+ docker/);
    assert.match(warns[0], /NASSAJ_SECURITY_POSTURE=strict/);
  });

  it('records the finding for the UI with a stable id and remediation', () => {
    const { deps, recorded } = makeDeps({ shared: false, getgroups: () => [989] });
    enforceDockerSockBootGuard(deps);
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].id, 'docker-sock-exposed');
    assert.equal(recorded[0].severity, 'warning');
    assert.match(String(recorded[0].detail), /docker\.sock is owned by gid 989/);
    assert.ok(Array.isArray(recorded[0].remediation) && recorded[0].remediation.length > 0);
  });

  it('degrades the UNVERIFIABLE path too, under its own id', () => {
    const { deps, recorded, warns, errors } = makeDeps({
      shared: false,
      statSync: () => {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    });
    const res = enforceDockerSockBootGuard(deps);
    assert.equal(res.enforced, false);
    assert.equal(res.verified, false, 'an unverifiable boot must never claim it was verified');
    assert.equal(errors.length, 0);
    assert.equal(warns.length, 1);
    assert.equal(recorded[0].id, 'docker-sock-unverifiable');
  });

  it('still passes SILENTLY when the socket is absent — no warning to record', () => {
    const { deps, warns, recorded } = makeDeps({ shared: false, statSync: enoent });
    const res = enforceDockerSockBootGuard(deps);
    assert.equal(res.exposed, false);
    assert.equal(warns.length, 0);
    assert.equal(recorded.length, 0);
  });
});

describe('enforceDockerSockBootGuard — the SHARED default cannot be lost by omission', () => {
  // The 2026-07-14 veto still stands for shared hosts: no env flag disables the
  // refusal, and a caller that forgets to pass a posture gets the strict one.

  it('omitting `shared` entirely keeps the hard refusal', () => {
    const { deps } = makeDeps({ getgroups: () => [989] });
    delete (deps as Record<string, unknown>).shared;
    assert.throws(() => enforceDockerSockBootGuard(deps), DockerSockExposedError);
  });

  it('a non-boolean falsy-ish posture value does not silently downgrade', () => {
    // Only an explicit `false` degrades; anything else (undefined) is shared.
    const { deps } = makeDeps({ shared: undefined, getgroups: () => [989] });
    assert.throws(() => enforceDockerSockBootGuard(deps), DockerSockExposedError);
  });
});
