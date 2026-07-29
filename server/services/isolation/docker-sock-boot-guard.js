/**
 * Docker-socket boot guard (T-896 / B-170) — fail-closed on SHARED hosts, NO
 * disable flag (committee decision 2026-07-14, qa-critic veto on any escape
 * hatch; scope narrowed by owner decision 2026-07-29, T-1085).
 *
 * SCOPE (T-1085): the escalation this guard prevents is the server reaching
 * privilege its USERS do not already hold. On a shared host (>1 account, or
 * platform mode, or an operator-declared strict posture) that is real and the
 * refusal below is unchanged. On a single-user install it is vacuous: the one
 * person who can drive the agents is the same person who owns the login shell
 * and can run `docker run -v /:/host` themselves. Bricking that boot protected
 * nothing and made every ordinary install (a deployed node hit this on
 * 2026-07-29) require sudo surgery before nassaj would start. So the posture
 * decides the ACTION, never the DETECTION: an exposed single-user node boots
 * with a loud warning recorded in boot-security-status and surfaced in the UI.
 * There is still NO env flag that turns the shared-host refusal off.
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
 *   - socket present, gid held            → SHARED posture: operational fatal
 *     error with the exact degroup remediation steps, then
 *     DockerSockExposedError (startServer's catch exits 1 before the listener
 *     ever opens). SINGLE-USER posture: the same message is logged as a
 *     warning and recorded for the UI; boot continues;
 *   - cannot determine (stat error other than absence, or a platform without
 *     getgroups while the socket exists) → SHARED posture: FAIL CLOSED on the
 *     same fatal path, but with its OWN diagnostic message (qa-critic
 *     2026-07-14: the degroup steps are wrong medicine for a stat failure and
 *     would mislead the operator); an unverifiable boot is treated as an
 *     exposed boot, never waved through. SINGLE-USER posture: warn and boot.
 *
 * DELIBERATE fail-closed trade-off on unexpected errno (documented per the
 * 2026-07-14 review): a host-filesystem fault that makes the socket
 * unstat-able (EACCES on /var/run, EIO, ELOOP from a tampered symlink chain…)
 * refuses boot on a node that might factually be safe — including a
 * production node. That cost is accepted BY DESIGN: this guard protects against
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

import { recordBootSecurityWarning } from './boot-security-status.js';

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
    'This guard is fail-closed BY DESIGN on shared hosts and has no disable flag',
    '(committee 2026-07-14; single-user scope narrowing 2026-07-29, T-1085).',
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
    'This guard is fail-closed BY DESIGN on shared hosts and has no disable flag',
    '(committee 2026-07-14; single-user scope narrowing 2026-07-29, T-1085).',
  ].join('\n');
}

/**
 * Header prepended when a SINGLE-USER node boots despite an exposed or
 * unverifiable socket. It states plainly that detection did NOT change and why
 * enforcement did, so nobody reads the surviving boot as "the guard passed".
 * @param {string} reason  posture reason from resolveSecurityPosture
 * @returns {string}
 */
function buildDegradedWarningHeader(reason) {
  return [
    '[docker-sock-guard] BOOTING ANYWAY (single-user host) — the finding below stands.',
    `Posture: single-user (${reason}). The one account able to drive an agent here is the`,
    'same human who owns this login session and can already reach the Docker socket from',
    'their own shell, so refusing to boot would cost availability and buy no security.',
    'Add a second account (or set NASSAJ_SECURITY_POSTURE=strict) and this becomes a',
    'HARD boot refusal again — the remediation below is what to run before you do.',
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
 * request handling (see server/index.js startServer). On exposure — or on any
 * state it cannot verify — it throws DockerSockExposedError when the host is
 * SHARED, and degrades to a recorded warning when the host is SINGLE-USER.
 * Returns a small result object whenever it does not throw.
 *
 * Dependencies are injectable for tests; production callers use the defaults
 * (the real fs.statSync and the live process group functions).
 *
 * `shared` defaults to TRUE — omitting it keeps the original fail-closed
 * behavior, so a caller that never learned about postures cannot accidentally
 * weaken the guard. server/index.js passes the resolved posture explicitly.
 *
 * @param {object} [deps]
 * @param {string} [deps.sockPath]
 * @param {(p: string) => import('node:fs').Stats} [deps.statSync]
 * @param {() => number[]} [deps.getgroups]
 * @param {() => number} [deps.getgid]
 * @param {() => number} [deps.getegid]
 * @param {boolean} [deps.shared]        shared-host posture (default: true)
 * @param {string} [deps.postureReason]  why that posture was chosen (for logs)
 * @param {(msg: string) => void} [deps.logError]
 * @param {(msg: string) => void} [deps.logWarn]
 * @param {(msg: string) => void} [deps.logInfo]
 * @param {(w: object) => void} [deps.recordWarning]
 * @returns {{ checked: boolean, exposed: boolean, verified: boolean,
 *             enforced: boolean, sockGid: number|null }}
 */
export function enforceDockerSockBootGuard(deps = {}) {
  const {
    sockPath = DOCKER_SOCK_PATH,
    statSync = fs.statSync,
    shared = true,
    postureReason = 'posture not supplied — defaulting to shared (fail-closed)',
    logError = console.error,
    logWarn = console.warn,
    logInfo = console.log,
    recordWarning = recordBootSecurityWarning,
  } = deps;

  /**
   * Single exit for both bad outcomes: refuse on a shared host, warn on a
   * single-user one. Detection is identical either way — only the action
   * differs, and the degraded path still logs the FULL fatal text so the
   * operator sees the same diagnosis and remediation.
   * @param {string} message   built fatal message (exposed or unverifiable)
   * @param {'exposed'|'unverifiable'} kind
   * @param {{ checked: boolean, exposed: boolean, verified: boolean, sockGid: number|null }} result
   */
  const refuseOrWarn = (message, kind, result) => {
    if (shared) {
      logError(message);
      throw new DockerSockExposedError(message);
    }
    logWarn(`${buildDegradedWarningHeader(postureReason)}\n${message}`);
    recordWarning({
      id: `docker-sock-${kind}`,
      severity: 'warning',
      title:
        kind === 'exposed'
          ? 'This server can reach the Docker control socket'
          : 'Docker-socket exposure could not be verified',
      detail: message,
      remediation: [
        'sudo gpasswd -d $(whoami) docker',
        'log out and back in (or: pm2 kill && pm2 resurrect) so the daemon drops the stale group',
      ],
    });
    return { ...result, enforced: false };
  };
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
      return { checked: false, exposed: false, verified: true, enforced: true, sockGid: null };
    }
    // Present-but-unverifiable is indistinguishable from exposed: fail closed.
    const message = buildUnverifiableFatalMessage(
      `cannot stat ${sockPath} (${code || err?.message || 'unknown error'}) — unverifiable state is treated as exposed`,
    );
    return refuseOrWarn(message, 'unverifiable', {
      checked: true,
      exposed: true,
      verified: false,
      sockGid: null,
    });
  }

  // NUMERIC owning gid of the socket (e.g. 989). Never resolve it to a name.
  const sockGid = stat.gid;

  const gids = collectProcessGids({ getgroups, getgid, getegid });
  if (gids === null) {
    const message = buildUnverifiableFatalMessage(
      `${sockPath} exists but this platform cannot report process groups — unverifiable state is treated as exposed`,
    );
    return refuseOrWarn(message, 'unverifiable', {
      checked: true,
      exposed: true,
      verified: false,
      sockGid,
    });
  }

  if (gids.has(sockGid)) {
    const message = buildExposedFatalMessage(
      `${sockPath} is owned by gid ${sockGid} and this process HOLDS gid ${sockGid} ` +
        `(process gids: ${[...gids].sort((a, b) => a - b).join(', ')})`,
    );
    return refuseOrWarn(message, 'exposed', {
      checked: true,
      exposed: true,
      verified: true,
      sockGid,
    });
  }

  logInfo(
    `[docker-sock-guard] pass: ${sockPath} owned by gid ${sockGid}; process does not hold it`,
  );
  return { checked: true, exposed: false, verified: true, enforced: true, sockGid };
}
