/**
 * provider-cage-wiring — the thin seam between the pure cage builder
 * (provider-cage.js) and the live per-provider launch sites (T-897 m2).
 *
 * Why a separate module: buildCagedLaunch is deliberately PURE (argv in →
 * argv out; its 15 unit tests feed it fictional paths). Real launches need
 * two on-disk facts first — where the per-user trees root lives and whether
 * the bind sources actually exist (bwrap --bind fails on a missing source).
 * This module owns exactly that impure glue, so every launcher wires the cage
 * with one call and zero per-file policy.
 *
 * Flag economics (NASSAJ_PROVIDER_CAGE, default OFF): with the flag off,
 * resolveCagedLaunch returns `{ cmd, args }` with the SAME references it was
 * given and touches no filesystem (and reads no sharing policy), and
 * buildCagedSdkSpawn returns undefined so the SDK option is never even set —
 * the off path is byte-identical to the pre-wiring behaviour at every launch
 * site.
 *
 * T-898 (2026-07-15): on top of the T-897 denylist this module now computes a
 * per-launch cageMountPlan — masking EVERY shared-$HOME provider credential
 * (GAP 1 of the 2026-07-14 spike: full credential harvest was possible in one
 * caged turn) while re-binding the launching provider's own by-design-shared
 * stores + toolchain caches read-write (GAP 2: ro shared stores silently
 * dropped transcripts / EROFS-broke hermes). See cageMountPlan for the
 * entitlement rules (admin-policy shared mode ONLY — the forgeable isolated
 * owner-reuse-symlink exemption was removed, see the forgery-closure note below).
 *
 * T-898 pre-go-live hardening (2026-07-15, second qa-critic pass): the GAP-1
 * sweep is widened past the provider-keyed set to the WHOLE shared-$HOME secret
 * surface the qa-critic proved readable — non-provider operator secrets
 * (CAGE_OPERATOR_SECRET_FILES: .config/gh/hosts.yml, .nassaj-provider-secrets.key,
 * …) masked with /dev/null, and operator secret DIRECTORIES (CAGE_SECRET_HIDE_DIRS
 * + globbed cdxrt.*​/secret) blanked with tmpfs. This stays a DENYLIST and is
 * therefore fail-OPEN for any FUTURE secret dropped into $HOME (root fix =
 * allowlist; deferred to owner, see the spike). The flag stays OFF and the
 * off-path is byte-identical.
 *
 * T-898 forgery closure (2026-07-15, same second qa-critic pass, disk-PoC-proven):
 * the per-user tree is bind-mounted READ-WRITE inside the cage, so the old isolated
 * owner-reuse exemption — which trusted an on-disk
 * ~/.nassaj-users/<id>/.claude/.credentials.json → operator-credential symlink,
 * checked by realpath equality — was FORGEABLE from inside the cage: a
 * prompt-injected session deletes its own credential, plants that symlink, and the
 * next launch's fresh cageMountPlan hands it the LIVE operator credential rw (the
 * qa-critic extracted 509 B of OAuth + gained a rotate/corrupt primitive on the
 * fleet-shared credential = re-opened GAP 1). That exemption is REMOVED: the
 * shared-credential mask set is authoritative by realpath and is only ever waived
 * for the launching provider's OWN credential in admin-policy SHARED mode — a
 * sharing-DB decision, never a surface the cage can write. An isolated user's own
 * credential lives INSIDE its per-user tree (a real path that is a strict descendant
 * of ~/.nassaj-users/<id>) and stays writable through the tree rebind, untouched.
 *
 * The isProviderIsolated import is read lazily per caged launch only (flag-on
 * path); provider-sharing/appConfigDb open their connection on first use, so
 * merely importing this module still touches no database.
 *
 * NOTE: resolve-provider-env.js (the natural env seam) is intentionally NOT
 * involved — it is under parallel work (handoff 2026-07-14); this module
 * wires the launchers directly and independently of the env resolver.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isProviderIsolated } from '../provider-sharing.js';

import { buildCagedLaunch, cageEnabled } from './provider-cage.js';

/**
 * Root of the per-user isolated config trees, mirroring
 * provision-user-dirs.js (NOT imported: that module drags the database layer
 * in, and this seam must stay importable by pure launch code and tests).
 * Returns undefined when the root does not exist on disk — nothing to hide,
 * and bwrap must not be pointed at a missing tmpfs target.
 *
 * @param {{ homedir?: () => string, existsSync?: (p: string) => boolean }} [deps]
 * @returns {string|undefined}
 */
export function cageUsersRoot({ homedir = os.homedir, existsSync = fs.existsSync } = {}) {
  const root = path.join(homedir(), '.nassaj-users');
  return existsSync(root) ? root : undefined;
}

/**
 * Fixed owner/operator secret DIRECTORIES (homedir-relative) blanked with an
 * empty tmpfs in every cage. Beyond the fleet SSH key (~/.ssh, T-897) this
 * sweeps the whole shared-$HOME secret-DIRECTORY surface a prompt-injected caged
 * provider could otherwise read wholesale (T-898 — the same GAP-1 class the
 * qa-critic veto was built on, now proven to reach non-provider operator secrets
 * too):
 *   - .ssh              fleet SSH private key (T-897)
 *   - .gnupg            GPG private keyring
 *   - .cloudflared      tunnel cert.pem + named-tunnel credential JSON
 *   - .aws              AWS credentials/config
 *   - .config/gcloud    GCP application-default credentials
 *   - .cloudcli         stale auth.db (password hashes + api_keys + user_credentials)
 *   - .local/share/nassaj-dev  the LIVE app db.sqlite (password hashes + api_keys)
 *   - .nassaj-provider-secrets the shared encrypted provider keystore (dir form)
 * None is read by any caged provider CHILD: the nassaj SERVER (which reads
 * db.sqlite and the keystore) is the PARENT and is never caged, and mount
 * namespaces are per-child, so hiding these inside the child denies the harvest
 * while the parent's own view is untouched. The `cdxrt.*​/secret` Codex runtime
 * copies are added dynamically (see cdxrtSecretDirs).
 * @type {readonly string[]}
 */
export const CAGE_SECRET_HIDE_DIRS = Object.freeze([
  '.ssh',
  '.gnupg',
  '.cloudflared',
  '.aws',
  path.join('.config', 'gcloud'),
  '.cloudcli',
  path.join('.local', 'share', 'nassaj-dev'),
  '.nassaj-provider-secrets',
]);

/**
 * Non-provider operator secret FILES (homedir-relative) masked UNCONDITIONALLY
 * with `--ro-bind /dev/null` in every cage. Unlike CAGE_SHARED_CREDENTIALS there
 * is NO entitlement/owner-reuse exemption: no provider owns these, so no caged
 * child ever legitimately reads them.
 *   - .config/gh/hosts.yml        GitHub OAuth (private-repo + CI-secret access) —
 *                                 the highest-value leak the 2026-07-15 qa-critic
 *                                 disk run proved readable inside the cage
 *   - .nassaj-provider-secrets.key  the 32-byte SERVER key that DECRYPTS every
 *                                 stored provider API key (a "*.key" private key;
 *                                 read only by the parent provider-secrets-store)
 *   - .docker/config.json         container-registry auth (docker.sock is already
 *                                 hidden, so docker is unusable in-cage regardless)
 *   - .netrc / .git-credentials   curl/git stored credentials
 * DELIBERATELY EXCLUDED — ~/.npmrc: npx-launched stdio MCP servers read it for
 * registry config, so a private-registry token there is a PROVIDER-NEEDED secret
 * → owner decision (spike residual), NOT a blind mask that would break MCP
 * install. Absent on every fleet node today (public registry only), so masking
 * it would change nothing functionally here — but the rule stays principled.
 * Blind filename globs (`*credential*`, `config.json`) are deliberately NOT used:
 * on disk they hit source files (~/.hermes/.../credential_*.py) and tool prefs
 * (~/.config/astro/config.json) — an explicit path denylist is the safe form.
 * @type {readonly string[]}
 */
export const CAGE_OPERATOR_SECRET_FILES = Object.freeze([
  path.join('.config', 'gh', 'hosts.yml'),
  '.nassaj-provider-secrets.key',
  path.join('.docker', 'config.json'),
  '.netrc',
  '.git-credentials',
]);

/**
 * The `secret/` subdir of every Codex runtime dir (~/cdxrt.<rand>/secret),
 * globbed live because the suffix is random and the dirs are ephemeral. Each
 * holds a copy of the Codex auth token; codex self-cages and is cage-EXEMPT, so
 * no non-codex provider ever needs them. Best-effort: a readdir failure yields
 * nothing (acceptable — this is defense in depth layered over the provider-keyed
 * masks). Point-in-time by nature: a cdxrt dir created AFTER a cage launched is
 * not retroactively hidden (documented residual).
 * @param {string} home
 * @param {(p: string) => string[]} readdirSync
 * @returns {string[]} absolute paths (existence checked by the caller)
 */
function cdxrtSecretDirs(home, readdirSync) {
  try {
    return readdirSync(home)
      .filter((name) => /^cdxrt\./.test(name))
      .map((name) => path.join(home, name, 'secret'));
  } catch {
    return [];
  }
}

/**
 * Owner/operator secret DIRECTORIES blanked with an empty tmpfs inside every
 * cage: the fixed set (CAGE_SECRET_HIDE_DIRS) plus the live-globbed Codex
 * runtime `secret/` dirs. Computed relative to the REAL homedir (os.homedir), so
 * it is correct on each fleet node where the owner user differs (nassaj here,
 * a different service account on each node) — never a hard-coded /home/<user>. Every path is
 * realpath-normalized (symlink safety, toRealMountPath) and existsSync-filtered:
 * nothing to hide otherwise, and it keeps the argv (and the bwrap mount count)
 * minimal.
 *
 * DELIBERATELY EXCLUDED here — ~/.claude.json (Anthropic OAuth token): tmpfs
 * mounts over a DIRECTORY only; pointing it at that FILE aborts bwrap boot
 * ("Can't mkdir …: Not a directory", verified 2026-07-14). It IS masked, as a
 * FILE, via CAGE_SHARED_CREDENTIALS → maskFiles (`--ro-bind /dev/null`), so no
 * secret is left readable; only the mount PRIMITIVE differs. Per-user Claude
 * isolation does not depend on the owner file: with CLAUDE_CONFIG_DIR pointed at
 * the user's own tree, `claude --version` and `claude mcp list` were verified to
 * boot with ~/.claude.json fully masked.
 *
 * @param {{ homedir?: () => string, existsSync?: (p: string) => boolean,
 *           realpathSync?: (p: string) => string,
 *           readdirSync?: (p: string) => string[] }} [deps]
 * @returns {string[]}
 */
export function cageSecretHidePaths({
  homedir = os.homedir,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
  readdirSync = fs.readdirSync,
} = {}) {
  const home = homedir();
  const dirs = [
    ...CAGE_SECRET_HIDE_DIRS.map((rel) => path.join(home, rel)),
    ...cdxrtSecretDirs(home, readdirSync),
  ];
  return dirs.filter((p) => existsSync(p)).map((p) => toRealMountPath(p, realpathSync));
}

/**
 * The non-provider operator secret FILES to mask in every cage
 * (CAGE_OPERATOR_SECRET_FILES), realpath-normalized + existsSync-filtered.
 * Unconditional: unlike cageMountPlan's provider-keyed credential masks there is
 * no entitlement exemption — none of these is ever legitimately read by a caged
 * child, so the launching provider makes no difference.
 *
 * @param {{ homedir?: () => string, existsSync?: (p: string) => boolean,
 *           realpathSync?: (p: string) => string }} [deps]
 * @returns {string[]}
 */
export function cageOperatorSecretMasks({
  homedir = os.homedir,
  existsSync = fs.existsSync,
  realpathSync = fs.realpathSync,
} = {}) {
  const home = homedir();
  return CAGE_OPERATOR_SECRET_FILES.map((rel) => path.join(home, rel))
    .filter((p) => existsSync(p))
    .map((p) => toRealMountPath(p, realpathSync));
}

/**
 * Every provider credential FILE living in the shared operator $HOME, relative
 * to homedir — the exact set the 2026-07-14 spike proved READABLE inside the
 * denylist cage (GAP 1: full credential harvest in one prompt-injected turn).
 * Keyed by the provider each file belongs to, because the launching provider's
 * OWN credential may be legitimately needed (see cageMountPlan) while every
 * other provider's credential is always masked.
 *
 * Deliberately absent:
 *  - gemini: no operator-level gemini-cli credential file exists on any fleet
 *    node (verified on disk 2026-07-15 — ~/.gemini holds only antigravity-cli/,
 *    config/, projects/, sessions/, tmp/); the antigravity OAuth token is agy's
 *    and is listed under agy.
 *  - cursor: not installed on any fleet node; no credential path to verify.
 *    Revisit when a node has it (T-897 spike note).
 *  - glm: no glm credential FILE of its own — the glm key is written as a JSON
 *    entry INSIDE opencode's auth.json (carrier model, GL-1), already covered by
 *    the `opencode` entry, so a kimi/other-provider cage masks it via that path.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const CAGE_SHARED_CREDENTIALS = Object.freeze({
  claude: Object.freeze([path.join('.claude', '.credentials.json'), '.claude.json']),
  codex: Object.freeze([path.join('.codex', 'auth.json')]),
  agy: Object.freeze([path.join('.gemini', 'antigravity-cli', 'antigravity-oauth-token')]),
  hermes: Object.freeze([path.join('.hermes', 'auth.json')]),
  opencode: Object.freeze([path.join('.local', 'share', 'opencode', 'auth.json')]),
  // Kimi agent (SL-6/KG-1): the native CLI WRITES a credential/state file to its
  // config-home (KIMI_CODE_HOME), unlike the chat path which only injects an env
  // key. The operator-level credential lives under the default config-home
  // ~/.kimi-code/ (the same subdir the agent MCP config uses,
  // <KIMI_CODE_HOME>/.kimi-code/mcp.json). Masked like every other provider
  // credential: an isolated kimi agent reads its OWN key from its per-user tree,
  // so the operator copy is always masked (no waiver). existsSync-filtered, so a
  // node that never ran `kimi login` masks nothing; the exact on-disk filename is
  // reconfirmed by the G-KIMI-LIVE field gate and adjusted here if it differs.
  kimi: Object.freeze([path.join('.kimi-code', 'auth.json')]),
});

/**
 * Shared stores (relative to homedir) the LAUNCHING provider must keep writing
 * to inside the cage. Everything here is shared BY DESIGN (ADR-023: one
 * conversation history for all users), so re-binding it read-write inside the
 * cage grants nothing a live spawn does not already have today — while leaving
 * it read-only silently drops transcripts/state (GAP 2, spike 2026-07-14:
 * a real caged claude turn completed with NO transcript persisted; hermes
 * EROFS-fails outright). Isolation is untouched: only the launching provider's
 * own store is re-bound; every other provider's store stays read-only and the
 * per-user trees stay hidden.
 *
 * Shape note — isolated vs shared launches differ: an ISOLATED provider writes
 * its private state into the user's own re-bound tree and only needs the
 * narrow, by-design-shared store (e.g. ~/.claude/projects, reached through the
 * per-user `projects` symlink provisionUserDirs creates). A SHARED-mode
 * provider (admin policy, e.g. agy/opencode today) runs directly on the
 * operator tree and needs its whole state dir writable, exactly as it is
 * without the cage.
 *
 * @param {string} launching normalized provider name
 * @param {boolean} isolated isProviderIsolated(launching)
 * @returns {string[]} homedir-relative paths
 */
function launchingProviderWriteStores(launching, isolated) {
  switch (launching) {
    case 'claude':
      return isolated
        ? [path.join('.claude', 'projects')]
        : ['.claude', '.claude.json'];
    case 'gemini':
      return isolated ? [path.join('.gemini', 'projects')] : ['.gemini'];
    case 'agy':
      return isolated
        ? [path.join('.gemini', 'antigravity-cli', 'brain')]
        : [path.join('.gemini', 'antigravity-cli')];
    case 'hermes':
      // No per-user knob at all — ~/.hermes (state.db + auth) is always shared.
      return ['.hermes'];
    case 'opencode':
      return isolated
        ? []
        : [path.join('.local', 'share', 'opencode'), path.join('.local', 'state', 'opencode')];
    case 'kimi':
      // Kimi agent (SL-6) runs isolated per-user: KIMI_CODE_HOME points into the
      // caller's own tree (rebound rw via usersRoot in buildCagedLaunch), so
      // there is no operator-level shared store to re-bind — only the toolchain
      // caches (added unconditionally by the caller) are needed. No shared-mode
      // form exists (the agent is always per-user), so both branches are empty.
      return [];
    default:
      // cursor + any future provider: no known shared store to re-bind.
      return [];
  }
}

/**
 * The MCP/toolchain caches every caged provider needs WRITABLE: `npx`-launched
 * stdio MCP servers die on EROFS in ~/.npm/_cacache (spike artifact 03; with a
 * writable ~/.npm the playwright MCP server boots — artifact 04), and browser/
 * uv caches live under ~/.cache. Shared-rw across users is the documented
 * trade-off (same as today without the cage); per-user cache redirection is a
 * follow-up owner decision (spike recommendation §2).
 * @type {readonly string[]}
 */
const CAGE_TOOLCHAIN_CACHES = Object.freeze(['.npm', '.cache']);

/**
 * Resolves a mount path to its REAL path, falling back to the input when
 * resolution fails. bwrap cannot use a bind/tmpfs DEST that traverses a
 * symlink ("Can't mkdir …: No such file or directory" — proven on disk
 * 2026-07-15: ~/.claude is itself a symlink to ~/nassaj-core on fleet nodes),
 * while mounting on the resolved real path works AND is reached by runtime
 * lookups through any symlinked alias (the kernel resolves the alias onto the
 * mounted target). Masking/binding the real path also closes the aliasing
 * loophole: no alternate path to the same file escapes the mount.
 *
 * @param {string} p
 * @param {(p: string) => string} realpathSync
 * @returns {string}
 */
function toRealMountPath(p, realpathSync) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Computes the per-launch mount plan that closes the two structural gaps the
 * 2026-07-14 spike proved on disk (see docs/spikes/2026-07-14-provider-cage-spike.md),
 * hardened by the second qa-critic pass (2026-07-15 forgery closure, see the module
 * header):
 *
 *   maskFiles  (GAP 1) — EVERY shared-$HOME provider credential that exists is
 *   blanked with a /dev/null file-bind, keyed by REAL path (toRealMountPath) so no
 *   symlink alias escapes the mask. This shared-credential mask set is
 *   AUTHORITATIVE: a credential real path is only ever pulled OUT of the mask (into
 *   a read-write bind) for the launching provider's OWN credential AND ONLY in
 *   admin-policy SHARED mode (isProviderIsolated false) — the spawn legitimately
 *   runs on the operator credential, that IS the sharing policy, so it stays
 *   readable + rw (a refresh that cannot persist a rotated token breaks auth). That
 *   waiver is read from the sharing DB, NEVER from on-disk state.
 *
 *   An ISOLATED launch earns NO credential waiver: its operator credential is
 *   ALWAYS masked. The user runs on its own per-user tree (CLAUDE_CONFIG_DIR/
 *   CODEX_HOME), whose real credential file lives INSIDE ~/.nassaj-users/<id>/ — a
 *   strict descendant of the user tree, already writable through the per-user tree
 *   rebind in buildCagedLaunch. The operator credential's real path is never a
 *   descendant of that tree, so no on-disk symlink (forged or provisioned) can turn
 *   it writable. The previous "owner-reuse symlink ⇒ operator credential rw"
 *   exemption is deliberately gone: the tree is rw inside the cage, so that link was
 *   forgeable (qa-critic 2026-07-15 disk PoC).
 *
 *   writePaths (GAP 2) — the launching provider's by-design-shared store(s) + the
 *   toolchain caches, re-bound read-write (see launchingProviderWriteStores), plus
 *   the shared-mode exempt credential, MINUS any candidate whose real path collides
 *   with a masked shared credential (a masked real path must NEVER be handed out
 *   read-write — belt to the "masks mounted last" suspenders in buildCagedLaunch).
 *
 * Both lists are existsSync-filtered (bwrap fails on a missing --bind source and
 * cannot mask a dest inside the read-only root) and realpath-normalized + deduped
 * (two logical paths may collapse to one real file — e.g. anything under the
 * ~/.claude → ~/nassaj-core symlink on fleet nodes).
 *
 * @param {{ provider: string, userId?: string|number|null }} spec
 * @param {{ homedir?: () => string, existsSync?: (p: string) => boolean,
 *           realpathSync?: (p: string) => string,
 *           isProviderIsolated?: (provider: string) => boolean }} [deps] test seam
 * @returns {{ writePaths: string[], maskFiles: string[] }}
 */
export function cageMountPlan({ provider, userId }, deps = {}) {
  const homedir = deps.homedir ?? os.homedir;
  const existsSync = deps.existsSync ?? fs.existsSync;
  const realpathSync = deps.realpathSync ?? fs.realpathSync;
  const providerIsolated = deps.isProviderIsolated ?? isProviderIsolated;

  const home = homedir();
  const launching = String(provider ?? '').trim().toLowerCase();
  const isolatedLaunch = providerIsolated(launching);
  const real = (abs) => toRealMountPath(abs, realpathSync);

  // (1) AUTHORITATIVE shared-credential mask set: every shared-$HOME provider
  // credential that exists, by real path. This set always wins on overlap; it is
  // only ever REDUCED by the shared-mode waiver below, never overridden by a bind.
  const sharedCredRealpaths = new Set();
  for (const relFiles of Object.values(CAGE_SHARED_CREDENTIALS)) {
    for (const rel of relFiles) {
      const abs = path.join(home, rel);
      if (existsSync(abs)) sharedCredRealpaths.add(real(abs));
    }
  }

  // (2) The launching provider's OWN credential is waived from the mask (readable +
  // rw) ONLY in admin-policy SHARED mode — a DB decision, never on-disk state. An
  // ISOLATED launch earns no waiver (its operator credential stays masked; it runs
  // on its per-user tree, whose own credential is a strict descendant, rw via the
  // tree rebind). This is what closes the forgeable owner-reuse-symlink path.
  const writeWaivedCreds = new Set();
  if (!isolatedLaunch) {
    for (const rel of CAGE_SHARED_CREDENTIALS[launching] ?? []) {
      const abs = path.join(home, rel);
      if (existsSync(abs)) writeWaivedCreds.add(real(abs));
    }
  }

  const maskSet = new Set([...sharedCredRealpaths].filter((rp) => !writeWaivedCreds.has(rp)));

  // (3) writePaths: by-design-shared stores + toolchain caches, each existsSync-
  // filtered and realpath-normalized, MINUS any whose real path is a masked shared
  // credential; then the shared-mode waived credential(s). A masked real path can
  // never enter a write bind.
  const writePaths = new Set();
  for (const rel of [...launchingProviderWriteStores(launching, isolatedLaunch), ...CAGE_TOOLCHAIN_CACHES]) {
    const abs = path.join(home, rel);
    if (!existsSync(abs)) continue;
    const rp = real(abs);
    if (maskSet.has(rp)) continue;
    writePaths.add(rp);
  }
  for (const rp of writeWaivedCreds) writePaths.add(rp);

  return { writePaths: [...writePaths], maskFiles: [...maskSet] };
}

/**
 * Resolves the concrete `{ cmd, args }` a launcher must spawn for a provider
 * run — caged when (and only when) NASSAJ_PROVIDER_CAGE=true and the provider
 * is in scope (see cageEnabled: codex and the HTTP-hosted vendors are exempt).
 *
 * On-disk guards applied before delegating to the pure builder:
 *   - usersRoot: only passed when ~/.nassaj-users exists;
 *   - userId:    only passed when that user's own dir exists (bwrap --bind
 *                requires the source; a shared-provider user may have none —
 *                their tree simply stays hidden with everyone else's);
 *   - cwd:       only passed when it exists (launchers validate cwd anyway;
 *                this keeps a failed validation from becoming a bwrap error);
 *   - writePaths/maskFiles: the per-launch cageMountPlan (credential masks +
 *                shared-store write re-binds), every entry existsSync-filtered.
 *
 * @param {{ userId?: string|number|null, provider: string,
 *           mode?: string, cmd: string,
 *           args?: string[], cwd?: string|null }} spec
 *           mode: launch mode (SL-6) — 'agent' cages a CAGEABLE_AGENT_PROVIDERS
 *           vendor (kimi/glm) while its chat run stays exempt; omitted/'chat' is
 *           byte-identical to the pre-SL-6 behaviour for every existing caller.
 * @param {{ homedir?: () => string, existsSync?: (p: string) => boolean,
 *           lstatSync?: typeof fs.lstatSync, realpathSync?: (p: string) => string,
 *           readdirSync?: (p: string) => string[],
 *           isProviderIsolated?: (provider: string) => boolean,
 *           resolveBwrapPath?: () => (string|null) }} [deps] test seam
 * @returns {{ cmd: string, args: string[] }}
 */
export function resolveCagedLaunch({ userId, provider, mode, cmd, args = [], cwd }, deps = {}) {
  // Hot-path short-circuit: flag off / exempt provider ⇒ untouched references,
  // no filesystem access at all. The mode gate lives entirely in cageEnabled.
  if (!cageEnabled(provider, mode)) {
    return { cmd, args };
  }

  const existsSync = deps.existsSync ?? fs.existsSync;
  const usersRoot = cageUsersRoot(deps);
  const hidePaths = cageSecretHidePaths(deps);
  const { writePaths, maskFiles } = cageMountPlan({ provider, userId }, deps);
  // Provider-keyed credential masks (entitlement-aware) + unconditional
  // non-provider operator secret masks, deduped: two logical paths can resolve
  // to one real file (both /dev/null-bound harmlessly, but a Set keeps argv tidy).
  const allMaskFiles = [...new Set([...maskFiles, ...cageOperatorSecretMasks(deps)])];

  const uid = userId === null || userId === undefined ? '' : String(userId).trim();
  const ownDirExists =
    usersRoot !== undefined && uid !== '' && existsSync(path.join(usersRoot, uid));

  return buildCagedLaunch(
    {
      userId: ownDirExists ? uid : null,
      provider,
      mode,
      cmd,
      args,
      cwd: cwd && existsSync(cwd) ? cwd : undefined,
      usersRoot,
      hidePaths,
      writePaths,
      maskFiles: allMaskFiles,
    },
    deps.resolveBwrapPath ? { resolveBwrapPath: deps.resolveBwrapPath } : undefined,
  );
}

/**
 * Builds the `spawnClaudeCodeProcess` hook for the Claude Agent SDK spawn
 * seams (live chat query, built-in-commands probe, catalog probe) — the SDK's
 * documented extension point for running Claude Code inside containers/VMs,
 * which is exactly what the cage is.
 *
 * Returns undefined when the cage is off/out of scope so callers simply never
 * set the option (the SDK keeps its stock spawn — byte-identical off path).
 * When on, the hook wraps the SDK's fully-composed `{ command, args }` in the
 * unified bwrap argv and spawns it with the SDK-provided cwd/env/signal.
 *
 * stderr is 'ignore' — mirroring the SDK default (no options.stderr is used
 * anywhere in nassaj); piping without a reader could deadlock the child. The
 * only observable difference vs stock, cage aside, is that
 * DEBUG_CLAUDE_AGENT_SDK stderr echoing is unavailable while the cage is on.
 *
 * The returned hook is typed to the SDK's `SpawnedProcess` contract: the child
 * is spawned with piped stdin/stdout, so the concrete ChildProcess satisfies
 * the interface's non-null stream types at runtime.
 *
 * @param {{ userId?: string|number|null, cwd?: string|null }} spec
 * @param {{ spawn?: typeof spawn, homedir?: () => string,
 *           existsSync?: (p: string) => boolean,
 *           lstatSync?: typeof fs.lstatSync, realpathSync?: (p: string) => string,
 *           readdirSync?: (p: string) => string[],
 *           isProviderIsolated?: (provider: string) => boolean,
 *           resolveBwrapPath?: () => (string|null) }} [deps] test seam
 * @returns {((spec: { command: string, args: string[], cwd?: string,
 *            env?: Record<string, string|undefined>, signal?: AbortSignal }) =>
 *            import('@anthropic-ai/claude-agent-sdk').SpawnedProcess)|undefined}
 */
export function buildCagedSdkSpawn({ userId, cwd }, deps = {}) {
  if (!cageEnabled('claude')) {
    return undefined;
  }
  const spawnFn = deps.spawn ?? spawn;
  return (spec) => {
    const launch = resolveCagedLaunch(
      {
        userId,
        provider: 'claude',
        cmd: spec.command,
        args: spec.args ?? [],
        cwd: spec.cwd ?? cwd,
      },
      deps,
    );
    return spawnFn(launch.cmd, launch.args, {
      cwd: spec.cwd,
      env: spec.env,
      signal: spec.signal,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  };
}
