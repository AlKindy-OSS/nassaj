/**
 * provider-cage — unified bubblewrap (bwrap) sandbox for local provider spawns.
 *
 * Ultracode workshop decision (2026-07-14): every provider that runs a local
 * child CLI is isolated through ONE bwrap cage baked into nassaj's own code, so
 * the same hardening ships across the fleet instead of being reinvented per
 * provider. This module is the pure seam that decides WHETHER to cage and BUILDS
 * the caged `{ cmd, args }`. It is intentionally standalone: Phase 1 wires it to
 * no live spawn path (that follows a per-provider spike once resolve-provider-env
 * stabilizes).
 *
 * Cage shape (unprivileged, no root — verified on disk 2026-07-14; extended
 * 2026-07-15 with write re-binds + credential file-masks, T-898):
 *   bwrap --unshare-user --unshare-pid --unshare-ipc \
 *         --ro-bind / / --dev /dev --proc /proc \
 *         --tmpfs /run --tmpfs /tmp \
 *         --tmpfs <hidePath>… \
 *         --bind <writePath> <writePath>… \
 *         --tmpfs <usersRoot> --bind <usersRoot>/<userId> <usersRoot>/<userId> \
 *         --bind <cwd> <cwd> \
 *         --ro-bind /dev/null <maskFile>… \
 *         -- <cmd> <args...>
 * <hidePath> are extra owner-secret DIRECTORIES blanked with an empty tmpfs
 * (e.g. ~/.ssh — the fleet key); computed by the wiring layer, passed in.
 * <writePath> are shared stores the launching provider must keep WRITING to
 * (e.g. ~/.claude/projects — the by-design-shared transcript store, ADR-023 —
 * and the ~/.npm / ~/.cache toolchain caches MCP needs): under a plain
 * `--ro-bind / /` those writes EROFS-fail silently (GAP 2, spike 2026-07-14),
 * so each is re-bound read-write. Computed per provider by the wiring layer.
 * <maskFile> are single credential FILES blanked by binding host /dev/null on
 * top (GAP 1: `--ro-bind / /` leaves every operator credential in the shared
 * $HOME readable; tmpfs cannot mount over a FILE — verified 2026-07-14 — so a
 * file needs the /dev/null bind). Masks are mounted LAST so no later bind
 * (user rebind, cwd, writePaths) can ever re-expose a masked credential.
 * Effect: another user's ~/.nassaj-users tree is hidden (tmpfs over the root,
 * only the caller's own dir re-bound rw), host runtime sockets like
 * /run/docker.sock disappear (tmpfs /run), /proc/<pid>/root is sealed by the new
 * user+pid namespace, while the child still boots normally (whole FS read-only).
 *
 * Scope: caging is opt-in behind NASSAJ_PROVIDER_CAGE=true and applies to the
 * local-CLI providers (claude/gemini/agy/opencode/cursor/hermes). Two exemption
 * classes never get wrapped — see CAGE_EXEMPT_PROVIDERS.
 *
 * Per-mode caging (SL-6 / ADR-062, 2026-07-22): kimi and glm live in
 * HTTP_HOSTED_PROVIDERS because their CHAT surface is a toolless HTTP client with
 * no child to sandbox — so they stay exempt in chat mode. But their AGENT surface
 * spawns a REAL local CLI (kimi = @moonshot-ai/kimi-code native; glm = via the
 * OpenCode carrier) that MUST be caged. The exempt-by-name test is therefore
 * replaced by exempt-by-(name AND mode): the chat/agent distinction is drawn HERE,
 * by an EXPLICIT `mode` threaded through the launch seam, never by provider name
 * alone (a name-only switch would silently un-cage the agent path — the KG-9
 * hazard). See cageEnabled + CAGEABLE_AGENT_PROVIDERS. An omitted/`'chat'` mode is
 * byte-identical to the pre-SL-6 behaviour (kimi/glm/deepseek exempt).
 *
 * @typedef {'claude'|'gemini'|'codex'|'agy'|'cursor'|'opencode'|'hermes'|'kimi'|'deepseek'|'glm'} ProviderName
 * @typedef {'chat'|'agent'|''|undefined|null} ProviderMode
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);

/**
 * Hosted third-party providers reached purely over HTTP. The local nassaj
 * process only holds a `fetch`-based client for these (see
 * modules/providers/shared/vendor/vendor-runtime.js) — there is NO child CLI to
 * sandbox. Mirrors resolve-provider-env.js's "hosted third-party HTTP APIs".
 * @type {readonly string[]}
 */
export const HTTP_HOSTED_PROVIDERS = Object.freeze(['kimi', 'deepseek', 'glm']);

/**
 * Providers exempt from the unified cage:
 *  - `codex` already self-cages via config-injection (its own bwrap). Wrapping it
 *    again would nest bubblewrap inside bubblewrap — a fragile double sandbox — so
 *    it is left to cage itself.
 *  - the HTTP_HOSTED_PROVIDERS have no local process to wrap.
 * Everything else, when the flag is on, IS caged (secure default: cage-by-default,
 * exempt-by-explicit-list).
 * @type {ReadonlySet<string>}
 */
export const CAGE_EXEMPT_PROVIDERS = Object.freeze(
  new Set(['codex', ...HTTP_HOSTED_PROVIDERS]),
);

/**
 * HTTP-hosted vendors that ALSO ship a local AGENT CLI which must be caged when
 * run in agent mode — the ONLY providers whose exemption is mode-dependent:
 *  - `kimi`: native `@moonshot-ai/kimi-code` spawn (ADR-062, KG-1).
 *  - `glm` : run through the OpenCode carrier (ADR-062, OCC-2). Included so that a
 *    launcher that identifies the carrier run as `glm` is caged too; the carrier's
 *    real binary is opencode (already caged), so in practice glm-agent reaches the
 *    cage as `opencode` — this entry makes the seam correct-by-construction either
 *    way.
 * `deepseek` is deliberately absent: it has no agent CLI, so it stays exempt in
 * every mode (chat-only HTTP client).
 * @type {ReadonlySet<string>}
 */
export const CAGEABLE_AGENT_PROVIDERS = Object.freeze(new Set(['kimi', 'glm']));

/** @param {unknown} provider @returns {string} */
function normalizeProvider(provider) {
  return String(provider ?? '')
    .trim()
    .toLowerCase();
}

/** @param {unknown} mode @returns {string} */
function normalizeMode(mode) {
  return String(mode ?? '')
    .trim()
    .toLowerCase();
}

/**
 * True only when the operator opted in (NASSAJ_PROVIDER_CAGE=true) AND the
 * provider has a local child to sandbox for this run.
 *
 * The chat/agent split is drawn HERE and ONLY here, by the explicit `mode`
 * (SL-6): an HTTP-hosted vendor with an agent CLI (CAGEABLE_AGENT_PROVIDERS) is
 * caged when `mode === 'agent'`; otherwise the static CAGE_EXEMPT_PROVIDERS list
 * governs (codex self-cages; the HTTP-hosted vendors have no chat-mode child).
 * An omitted/unrecognized/`'chat'` mode preserves the pre-SL-6 behaviour exactly
 * (kimi/glm/deepseek exempt), so every existing caller stays byte-identical.
 * An empty/unset provider is never cageable.
 *
 * @param {ProviderName|string} provider
 * @param {ProviderMode|string} [mode] launch mode; only 'agent' un-exempts a
 *        CAGEABLE_AGENT_PROVIDERS vendor. Case-insensitive; default is chat.
 * @returns {boolean}
 */
export function cageEnabled(provider, mode) {
  if (process.env.NASSAJ_PROVIDER_CAGE !== 'true') return false;
  const name = normalizeProvider(provider);
  if (name === '') return false;
  // Agent mode un-exempts the vendors that spawn a real local agent CLI. This is
  // the sole place the distinction is made, and it is made by explicit mode —
  // never by the provider name alone (KG-9): a name-only switch on `kimi` would
  // silently leave the agent path un-caged.
  if (normalizeMode(mode) === 'agent' && CAGEABLE_AGENT_PROVIDERS.has(name)) {
    return true;
  }
  return !CAGE_EXEMPT_PROVIDERS.has(name);
}

// --- bwrap resolution -------------------------------------------------------

/** @param {string} candidate @returns {boolean} */
function isExecutableFile(candidate) {
  try {
    if (!fs.statSync(candidate).isFile()) return false;
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * npm publishes the Codex binary via arch-specific optional deps named
 * `@openai/codex-<os>-<arch>`, and the bwrap "built for Codex" is vendored
 * inside them. e.g. linux/x64 → `codex-linux-x64`.
 * @returns {string}
 */
function platformPackageBaseName() {
  return `codex-${process.platform}-${process.arch}`;
}

/**
 * Given a platform-package root, find `vendor/<triple>/codex-resources/bwrap`.
 * The arch triple is globbed (readdir) so this stays correct on any target.
 * @param {string} rootDir
 * @returns {string|null}
 */
function bwrapUnderPlatformRoot(rootDir) {
  const vendorDir = path.join(rootDir, 'vendor');
  let triples;
  try {
    triples = fs.readdirSync(vendorDir);
  } catch {
    return null;
  }
  for (const triple of triples) {
    const candidate = path.join(vendorDir, triple, 'codex-resources', 'bwrap');
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/** @param {string} spec @returns {string|null} package root dir or null */
function tryResolvePackageRoot(spec) {
  try {
    return path.dirname(require.resolve(spec));
  } catch {
    return null;
  }
}

/**
 * Absolute fallbacks for the global npm layout used across the fleet (nested
 * platform package under the global @openai/codex install).
 * @type {readonly string[]}
 */
const KNOWN_BWRAP_PATHS = Object.freeze([
  '/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/codex-resources/bwrap',
]);

/** Yields executable bwrap paths bundled with @openai/codex, best-first. */
function* bundledBwrapCandidates() {
  const base = platformPackageBaseName();

  // (a) Resolve the arch-specific platform package directly (hoisted layout,
  //     as npm installs it locally: node_modules/@openai/codex-linux-x64).
  const direct = tryResolvePackageRoot(`@openai/${base}/package.json`);
  if (direct) {
    const b = bwrapUnderPlatformRoot(direct);
    if (b) yield b;
  }

  // (b) Resolve via @openai/codex, then probe both the hoisted-sibling and the
  //     nested (npm-global) layouts of the platform package.
  const codexRoot = tryResolvePackageRoot('@openai/codex/package.json');
  if (codexRoot) {
    const siblingRoot = path.resolve(codexRoot, '..', base);
    const nestedRoot = path.join(codexRoot, 'node_modules', '@openai', base);
    for (const root of [siblingRoot, nestedRoot]) {
      const b = bwrapUnderPlatformRoot(root);
      if (b) yield b;
    }
  }

  // (c) Known absolute fallbacks.
  for (const abs of KNOWN_BWRAP_PATHS) {
    if (isExecutableFile(abs)) yield abs;
  }
}

/** @returns {string|null} first executable bwrap on PATH, else null */
function systemBwrapOnPath() {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'bwrap');
    if (isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve an executable bwrap. Preference order:
 *   1. the bwrap bundled with @openai/codex (built for Codex, works unprivileged)
 *   2. a system `bwrap` on PATH
 *   3. null
 * Null makes buildCagedLaunch fail SAFE (run the provider unwrapped) rather than
 * fail open or crash — there is simply no cage available to apply.
 * @returns {string|null}
 */
export function resolveBwrapPath() {
  for (const candidate of bundledBwrapCandidates()) return candidate;
  return systemBwrapOnPath();
}

// --- caged launch builder ---------------------------------------------------

/**
 * Build the concrete `{ cmd, args }` to spawn for a provider run.
 *
 *  - cage disabled OR provider exempt → passthrough `{ cmd, args }` unchanged.
 *  - cage enabled but no bwrap found  → passthrough + a warning ON EVERY SPAWN
 *    (FAIL-SAFE, never fail-open: a missing sandbox must not silently drop
 *    isolation AND must not block the spawn; we run unwrapped and shout each
 *    time — a dropped isolation layer is individually security-relevant, so it
 *    is deliberately NOT deduplicated).
 *  - cage enabled and bwrap available → wrap cmd/args in bwrap with the unified
 *    flags, hiding other users' trees and host sockets.
 *
 * Pure (no filesystem side effects) apart from the injectable bwrap lookup; the
 * caller is responsible for having provisioned `<usersRoot>/<userId>` and `cwd`
 * (bwrap --bind requires the source to exist), exactly like provisionUserDirs.
 *
 * @param {{ userId?: string|number|null, provider: ProviderName|string,
 *           mode?: ProviderMode|string,
 *           cmd: string, args?: string[], cwd?: string, usersRoot?: string,
 *           hidePaths?: string[], writePaths?: string[], maskFiles?: string[] }} spec
 *           mode: launch mode (SL-6). Passed straight to cageEnabled so an
 *           HTTP-hosted vendor's AGENT run is caged while its chat run is not;
 *           omitted/'chat' is the pre-SL-6 behaviour.
 *           hidePaths: extra owner-secret DIRECTORIES to blank with an empty
 *           tmpfs (e.g. ~/.ssh); computed by the caller.
 *           writePaths: shared stores/caches re-bound READ-WRITE so the
 *           launching provider keeps persisting (transcripts, MCP caches);
 *           computed per provider by the caller (must exist — bwrap --bind
 *           fails on a missing source).
 *           maskFiles: single credential FILES blanked with a read-only bind
 *           of host /dev/null, mounted LAST so nothing re-exposes them;
 *           computed per provider/user by the caller (must exist — bwrap
 *           cannot create a mount point inside the read-only root).
 * @param {{ resolveBwrapPath?: () => (string|null) }} [deps] injectable seam (tests)
 * @returns {{ cmd: string, args: string[] }}
 */
export function buildCagedLaunch(
  { userId, provider, mode, cmd, args = [], cwd, usersRoot, hidePaths = [], writePaths = [], maskFiles = [] },
  deps = {},
) {
  const passthrough = { cmd, args };
  if (!cageEnabled(provider, mode)) return passthrough;

  const resolve = deps.resolveBwrapPath || resolveBwrapPath;
  const bwrap = resolve();
  if (!bwrap) {
    // Warn on EVERY spawn (no memo): a dropped isolation layer must never fall
    // silent — each unwrapped launch is individually security-relevant.
    console.warn(
      '[provider-cage] NASSAJ_PROVIDER_CAGE=true but no bwrap found; running ' +
        'provider UNWRAPPED (fail-safe passthrough)',
      { provider: normalizeProvider(provider) },
    );
    return passthrough;
  }

  const bwrapArgs = [
    // Fresh user / pid / ipc namespaces (unprivileged userns).
    '--unshare-user',
    '--unshare-pid',
    '--unshare-ipc',
    // Whole host FS read-only, then overlay the writable / virtual mounts on top.
    '--ro-bind',
    '/',
    '/',
    '--dev',
    '/dev',
    '--proc',
    '/proc',
    // Empty /run hides host runtime sockets (e.g. /run/docker.sock).
    '--tmpfs',
    '/run',
    // Isolated scratch space.
    '--tmpfs',
    '/tmp',
  ];

  // Blank out extra owner-secret directories (e.g. ~/.ssh — the fleet SSH key)
  // with an empty tmpfs. MUST precede the per-user rebind below: if a hidden
  // dir ever contained the rebind target, the later --bind re-exposes it on
  // top; the reverse order would mask the user's own dir.
  for (const p of hidePaths) {
    if (p) bwrapArgs.push('--tmpfs', p);
  }

  // Re-expose the shared stores/caches this provider must keep WRITING to
  // (by-design-shared transcript stores, ~/.npm / ~/.cache for MCP). Placed
  // AFTER the hides (a write grant beats a hide only when the caller asked for
  // both explicitly) and BEFORE the usersRoot tmpfs + maskFiles, so isolation
  // overlays always win over writability on any overlap.
  //
  // Defense in depth (T-898 forgery closure): a path that is ALSO in maskFiles is
  // never emitted as a read-write bind. cageMountPlan already guarantees this, but
  // enforcing it at the builder means no caller — now or later — can re-expose a
  // masked credential by listing its real path in writePaths. Masks still mount
  // LAST, so this only drops a contradictory bind; it can never weaken a mask.
  const maskedSet = new Set(maskFiles.filter(Boolean));
  for (const p of writePaths) {
    if (p && !maskedSet.has(p)) bwrapArgs.push('--bind', p, p);
  }

  // Hide the entire per-user root, then re-expose ONLY this user's dir (rw) so a
  // caged provider can never read another user's sessions/credentials.
  if (usersRoot) {
    bwrapArgs.push('--tmpfs', usersRoot);
    const uid = userId === undefined || userId === null ? '' : String(userId);
    if (uid !== '') {
      const userDir = path.join(usersRoot, uid);
      bwrapArgs.push('--bind', userDir, userDir);
    }
  }

  // Writable project working dir (session output / edits land here).
  if (cwd) {
    bwrapArgs.push('--bind', cwd, cwd);
  }

  // Mask single credential FILES with a read-only bind of host /dev/null
  // (tmpfs only mounts over directories — pointing it at a file aborts bwrap
  // boot, verified 2026-07-14). Mounted LAST, deliberately: no later mount
  // exists to re-expose a masked credential — not the per-user rebind, not a
  // cwd that happens to contain one (e.g. a project rooted at $HOME), not a
  // writePaths grant.
  for (const f of maskFiles) {
    if (f) bwrapArgs.push('--ro-bind', '/dev/null', f);
  }

  bwrapArgs.push('--', cmd, ...args);
  return { cmd: bwrap, args: bwrapArgs };
}
