/**
 * Docker-socket boot guard (T-896 / B-170) — fail-closed, NO disable flag
 * (committee decision 2026-07-14, qa-critic veto on any escape hatch).
 *
 * Threat: the shared `nassaj` uid holding the docker group makes every AI
 * provider one `docker run -v /:/host` away from host root — a cage/sandbox
 * around a process that can reach docker.sock is "a jail with its key in the
 * prisoner's pocket". The host fix is degrouping (`gpasswd -d nassaj docker`),
 * but a pm2 God-daemon born BEFORE the degroup keeps the stale group and
 * re-inherits it into every restarted app (observed live 2026-07-14). This
 * guard makes that state unbootable: if the server process can reach
 * /var/run/docker.sock via its gids, refuse to serve at all.
 *
 * Check (numeric-only, per the adversarial review of T-896): stat the socket
 * and compare its OWNING GID as a NUMBER against the process's gids. Matching
 * by group NAME is forbidden — `groupdel docker` leaves the socket owned by
 * the raw gid (e.g. 989) with no name, which a name check would wave through.
 *
 * Outcomes:
 *   - socket absent (ENOENT/ENOTDIR)      → silent pass (nothing to escape to);
 *   - socket present, gid NOT held        → pass (logs one info line);
 *   - socket present, gid held            → operational fatal error with the
 *     exact degroup remediation steps, then DockerSockExposedError
 *     (startServer's catch exits 1 before the listener ever opens);
 *   - cannot determine (stat error other than absence, or a platform without
 *     getgroups while the socket exists) → FAIL CLOSED: same fatal path, but
 *     with its OWN diagnostic message (qa-critic 2026-07-14: the degroup
 *     steps are wrong medicine for a stat failure and would mislead the
 *     operator). An unverifiable boot is treated as an exposed boot, never
 *     waved through.
 *
 * DELIBERATE fail-closed trade-off on unexpected errno (documented per the
 * 2026-07-14 review): a host-filesystem fault that makes the socket
 * unstat-able (EACCES on /var/run, EIO, ELOOP from a tampered symlink chain…)
 * refuses boot on a node that might factually be safe — including production
 * traventure. That cost is accepted BY DESIGN: this guard protects against
 * root escape, and "cannot verify" is indistinguishable at boot time from
 * "exposed and hidden". Availability is recoverable by an operator fixing the
 * host FS; a silent waved-through root escape is not. The unverifiable
 * message spells out that distinction so the on-call operator debugs the
 * host, not the group membership.
 *
 * Residual (documented, out of this guard's mandate): a process running as
 * uid 0, or a setfacl ACL granting the uid direct socket access, bypasses the
 * gid check. Neither applies to the nassaj service model (non-root uid, no
 * ACLs); tracked in the T-896 spike report.
 */

import fs from 'node:fs';
import os from 'node:os';

/** Canonical Docker control-socket path (Debian/Ubuntu fleet nodes). */
export const DOCKER_SOCK_PATH = '/var/run/docker.sock';

/**
 * Typed refusal so callers/tests can assert without string matching. The
 * message carries the full operational remediation.
 */
export class DockerSockExposedError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'DockerSockExposedError';
  }
}

/** @returns {string} best-effort service username for the remediation text */
function serviceUser() {
  try {
    return os.userInfo().username || 'nassaj';
  } catch {
    return 'nassaj';
  }
}

/**
 * Fatal message for a PROVEN exposure (the process holds the socket's gid).
 * The remediation mirrors the verified 2026-07-14 procedure: gpasswd alone
 * does NOT clear an already-running pm2 daemon's cached groups — the daemon
 * must be regenerated from a clean login shell.
 * @param {string} detail  one-line reason this boot was refused
 * @returns {string}
 */
function buildExposedFatalMessage(detail) {
  const user = serviceUser();
  return [
    `[docker-sock-guard] REFUSING TO BOOT: ${detail}`,
    'A server that can reach the Docker control socket can trivially escape to host root',
    '(docker run -v /:/host), which defeats every provider read-isolation layer (B-170).',
    'Remediation (run as an operator with sudo, in YOUR OWN terminal):',
    `  1. sudo gpasswd -d ${user} docker        # drop the docker group from the service user`,
    `  2. su - ${user}                          # fresh CLEAN login shell (no stale groups);`,
    "     id | grep -c docker                 #   must print 0 before continuing",
    '  3. pm2 kill && pm2 resurrect            # regenerate the pm2 daemon WITHOUT the group',
    '     (a plain `pm2 restart` is NOT enough: the old daemon re-inherits the stale group)',
    `  4. verify: cat /proc/$(pm2 pid nassaj-dev)/status | grep Groups   # no docker gid`,
    'This guard is fail-closed BY DESIGN and has no disable flag (committee 2026-07-14).',
  ].join('\n');
}

/**
 * Fatal message for an UNVERIFIABLE state (socket present or presumed present
 * but the exposure check itself failed). Distinct from the exposed message on
 * purpose (qa-critic 2026-07-14): the degroup/gpasswd steps do not treat a
 * stat failure and would send the operator down the wrong path. Group
 * membership may be perfectly fine here — the guard refuses because it cannot
 * PROVE it, and an unverifiable boot is treated as an exposed boot by design
 * (accepted trade-off: a host-FS fault can refuse a factually-safe boot, even
 * on production; that beats waving through a hidden root escape).
 * @param {string} detail  one-line reason verification failed
 * @returns {string}
 */
function buildUnverifiableFatalMessage(detail) {
  return [
    `[docker-sock-guard] REFUSING TO BOOT (UNVERIFIABLE): ${detail}`,
    'This is NOT a proven docker-group exposure — the exposure check itself failed, and',
    'fail-closed treats "cannot verify" exactly like "exposed" (a server that can reach',
    'the Docker control socket is one `docker run -v /:/host` away from host root, B-170).',
    'Remediation: fix the HOST condition that broke the check, not group membership:',
    `  1. stat ${DOCKER_SOCK_PATH}             # reproduce the failing syscall; note the errno`,
    '  2. inspect the path chain (ls -ld /var /var/run /run) for permissions/symlink damage',
    '  3. if Docker is not meant to run on this node, remove the socket/daemon entirely —',
    '     an ABSENT socket passes this guard silently',
    'This guard is fail-closed BY DESIGN and has no disable flag (committee 2026-07-14).',
  ].join('\n');
}

/**
 * Collects every gid the process holds: supplementary groups PLUS the real and
 * effective gids. POSIX leaves it unspecified whether getgroups() includes the
 * effective gid, and a docker gid held as the PRIMARY group grants the same
 * socket access — so both are added explicitly. Numeric values only.
 *
 * @param {{ getgroups?: () => number[], getgid?: () => number,
 *           getegid?: () => number }} proc
 * @returns {Set<number>|null} null when the platform cannot report groups
 */
function collectProcessGids(proc) {
  if (typeof proc.getgroups !== 'function') {
    return null;
  }
  const gids = new Set(proc.getgroups());
  if (typeof proc.getgid === 'function') {
    gids.add(proc.getgid());
  }
  if (typeof proc.getegid === 'function') {
    gids.add(proc.getegid());
  }
  return gids;
}

/**
 * Enforces the docker-socket invariant at boot. Call BEFORE any listener /
 * request handling (see server/index.js startServer). Throws
 * DockerSockExposedError on exposure or on any state it cannot verify;
 * returns a small result object on pass (useful for tests/telemetry).
 *
 * Dependencies are injectable for tests; production callers use the defaults
 * (the real fs.statSync and the live process group functions).
 *
 * @param {object} [deps]
 * @param {string} [deps.sockPath]
 * @param {(p: string) => import('node:fs').Stats} [deps.statSync]
 * @param {() => number[]} [deps.getgroups]
 * @param {() => number} [deps.getgid]
 * @param {() => number} [deps.getegid]
 * @param {(msg: string) => void} [deps.logError]
 * @param {(msg: string) => void} [deps.logInfo]
 * @returns {{ checked: boolean, exposed: false, sockGid: number|null }}
 */
export function enforceDockerSockBootGuard(deps = {}) {
  const {
    sockPath = DOCKER_SOCK_PATH,
    statSync = fs.statSync,
    logError = console.error,
    logInfo = console.log,
  } = deps;
  // Group-introspection functions resolve to the LIVE process functions ONLY when
  // the caller OMITS the key. An explicitly-passed value is honored verbatim —
  // including `undefined` — so a test can model a platform WITHOUT getgroups by
  // passing `getgroups: undefined`. The previous `getgroups = process.getgroups`
  // parameter default silently reverted an explicit `undefined` back to the real
  // function, so only `null` could simulate absence (qa-critic 2026-07-15: a
  // testability wart, not a vuln). Fail-closed behavior is UNCHANGED: a
  // non-function still yields null in collectProcessGids → refuse to boot.
  const getgroups = 'getgroups' in deps ? deps.getgroups : process.getgroups;
  const getgid = 'getgid' in deps ? deps.getgid : process.getgid;
  const getegid = 'getegid' in deps ? deps.getegid : process.getegid;

  let stat;
  try {
    stat = statSync(sockPath);
  } catch (err) {
    const code = err?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      // No docker socket on this node — nothing to escape to. Silent pass.
      return { checked: false, exposed: false, sockGid: null };
    }
    // Present-but-unverifiable is indistinguishable from exposed: fail closed.
    const message = buildUnverifiableFatalMessage(
      `cannot stat ${sockPath} (${code || err?.message || 'unknown error'}) — unverifiable state is treated as exposed`,
    );
    logError(message);
    throw new DockerSockExposedError(message);
  }

  // NUMERIC owning gid of the socket (e.g. 989). Never resolve it to a name.
  const sockGid = stat.gid;

  const gids = collectProcessGids({ getgroups, getgid, getegid });
  if (gids === null) {
    const message = buildUnverifiableFatalMessage(
      `${sockPath} exists but this platform cannot report process groups — unverifiable state is treated as exposed`,
    );
    logError(message);
    throw new DockerSockExposedError(message);
  }

  if (gids.has(sockGid)) {
    const message = buildExposedFatalMessage(
      `${sockPath} is owned by gid ${sockGid} and this process HOLDS gid ${sockGid} ` +
        `(process gids: ${[...gids].sort((a, b) => a - b).join(', ')})`,
    );
    logError(message);
    throw new DockerSockExposedError(message);
  }

  logInfo(
    `[docker-sock-guard] pass: ${sockPath} owned by gid ${sockGid}; process does not hold it`,
  );
  return { checked: true, exposed: false, sockGid };
}
