/**
 * provisionUserDirs(userId) — per-user credential directory provisioning.
 *
 * Implements B-ISO-PROVISION (ADR-014): each user gets an isolated config tree
 * under ~/.nassaj-users/<userId>/ for Claude/agy/Codex credentials, while
 * conversations and instructions stay SHARED via symlinks back to the operator
 * root (~/.claude, ~/.gemini, ~/.codex).
 *
 * Layout created per user (dir mode 0700, sensitive files 0600):
 *   ~/.nassaj-users/<userId>/
 *     .claude/                         (isolated credentials)
 *       projects   -> ~/.claude/projects        (shared conversations)
 *       CLAUDE.md  -> ~/.claude/CLAUDE.md        (shared instructions, if present)
 *       NASSAJ.md  -> ~/.claude/NASSAJ.md        (shared instructions, if present)
 *       agents     -> ~/.claude/agents           (shared agent cards, if present —
 *                  ALL users; ADR-023 Decision 3: MCP/tools/files fully shared)
 *       skills     -> ~/.claude/skills           (shared skills, if present — ALL users)
 *       plugins    -> ~/.claude/plugins          (shared plugins, if present — ALL users)
 *       settings.json stays PER-USER on purpose (personal prefs, e.g. theme) —
 *                  intentionally NOT symlinked.
 *       .credentials.json -> ~/.claude/.credentials.json  (OWNER ONLY: the
 *                  bootstrap owner reuses the operator credential so an isolated
 *                  owner never has to re-login. Non-owner users get no link and
 *                  must `claude login` separately.)
 *     .gemini/
 *       antigravity-cli/                          (agy isolated credentials)
 *         brain            -> ~/.gemini/antigravity-cli/brain
 *                  (SHARED for ALL users — every user sees the same agy
 *                  conversations, mirroring .claude/projects. getBrainDir(userId)
 *                  resolves to exactly this path under isolation — agy-cli.js:99.)
 *         antigravity-oauth-token -> ~/.gemini/antigravity-cli/antigravity-oauth-token
 *                  (OWNER ONLY: the bootstrap owner reuses the operator agy token
 *                  so an isolated owner never re-authenticates. Non-owner users get
 *                  no link and must run `agy` to authenticate. installation_id and
 *                  settings.json are linked too for the owner when present.)
 *     .codex/
 *       (isolated credentials + neutral governance COPY)
 *       AGENTS.md  (a real read-only 0444 COPY of the NEUTRAL governance, whose
 *                  sha256 matches ~/.claude/AGENTS.md — the build-agents neutral
 *                  instructions a spawned Codex reads from $CODEX_HOME/AGENTS.md on
 *                  launch. A COPY, NOT a symlink: a Codex turn runs
 *                  danger-full-access, and a symlink to the shared fleet-wide source
 *                  could be written THROUGH to corrupt governance for every user; a
 *                  per-user copy caps the blast radius at that user's own next turn,
 *                  which the fail-closed spawn guard detects by fingerprint and
 *                  rewrites. See codex-governance-material.js. ADR-057 §5 + 2026-07-12
 *                  remediation.)
 *       auth.json -> ~/.codex/auth.json  (OWNER ONLY: the bootstrap owner reuses
 *                  the operator Codex credential so an isolated owner never re-logs
 *                  in — mirrors .claude/.credentials.json. Non-owners run `codex
 *                  login` to authenticate their own isolated ~/.codex.)
 *     .kimi/                             (KIMI_CODE_HOME — native kimi agent CLI, M-1)
 *       AGENTS.md   (read-only 0444 COPY of the NEUTRAL governance — soft reference,
 *                  best-effort, NOT fail-closed: kimi has no native bypass block, so
 *                  the hard controls are cage + permission ceiling + env sanitize.)
 *       sessions/                        (per-user session store; wire.jsonl per turn)
 *       .kimi-code/                      (holds mcp.json, written at launch by KM-4)
 *       auth.json -> ~/.kimi-code/auth.json  (OWNER ONLY, best-effort — exact operator
 *                  path confirmed at G-KIMI-LIVE. Non-owners authenticate their own.)
 *     .config/opencode/                  (REAL per-user config-home — GL-5 stops the old
 *                  shared operator whole-dir symlink so governance is a per-user COPY,
 *                  never a followed link into the shared fleet source)
 *       AGENTS.md   (real read-only 0444 COPY of the NEUTRAL governance whose sha256
 *                  matches ~/.claude/AGENTS.md — opencode OBEYS it at the ENFORCED tier;
 *                  the GL-5 spawn gate BLOCKS a carrier launch if it cannot be attested.
 *                  A COPY, NOT a symlink: the same write-through invariant as Codex.)
 *       agent/, command/, skills/ -> ~/.config/opencode/*  (SHARED non-security subdirs)
 *       opencode.json  (governed per-user 0444 COPY with the custom `glm` provider
 *                  block — GL-2.)
 *
 * Idempotent: safe to call on every spawn. Existing dirs/symlinks are left
 * untouched. The first creation per user is recorded once in audit_log.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

import { auditLogDb } from '../../modules/database/index.js';

import {
  CODEX_AGENTS_FILENAME,
  materializeGovernanceCopy,
  materializePersonaCopy,
  neutralGovernanceSource,
} from './codex-governance-material.js';
import { CODEX_AGENTS_SUBDIR } from './codex-coordinator-agents.js';
import {
  GEMINI_GOVERNANCE_FILENAME,
  materializeGeminiGovernance,
} from './gemini-governance-material.js';
import { listGovernanceExemptions } from './governance-exemption.js';
// SL-1 neutral primitive (aliased — codex-governance-material re-exports a same-named
// single-arg Codex facade above). Used directly for the Kimi governance COPY (M-1).
import { materializeGovernanceCopy as materializeVendorGovernanceCopy } from './vendor-cli-governance-material.js';
import { materializeOpenCodeConfig } from './opencode-config-material.js';
import { QWEN_HOME_SUBDIR, QWEN_SETTINGS_FILENAME } from './qwen-settings-material.js';

// Per-user isolated config trees are owner-only (0700): under a shared system
// uid this prevents any other local reader from listing another user's tree.
// (B-MU-OS-PERM, ADR-023 Decision 2.) `nassaj` itself owns every path so its
// own read/write is unaffected.
const DIR_MODE = 0o700;

// Sensitive credential files (the Claude OAuth/credentials JSON and any token
// file) are owner read/write only.
const FILE_MODE = 0o600;

// Credential filenames inside a user's .claude/ dir that must be 0600 whenever
// present (real files; symlinks are skipped — see chmodIfPresent).
const CLAUDE_CREDENTIAL_FILES = ['.credentials.json', '.claude.json'];

// agy (antigravity) keeps its state under ~/.gemini/antigravity-cli relative to
// HOME. Under isolation resolveProviderEnv overrides HOME to the per-user root,
// so agy materializes its token here. These are the relative subpaths inside a
// user's .gemini/ dir.
const AGY_DIR = path.join('.gemini', 'antigravity-cli');
const AGY_BRAIN_SUBDIR = 'brain';

// Sensitive agy credential filenames inside the antigravity-cli dir that must be
// 0600 whenever present as a REAL file (symlinks skipped — the owner's token is a
// symlink to the operator file and must not be re-chmod-ed).
const AGY_CREDENTIAL_FILES = ['antigravity-oauth-token'];

// Owner-only artifacts symlinked from the operator's agy dir so the bootstrap
// owner never re-authenticates. The token is the credential; installation_id and
// settings.json are reused for continuity when present.
const AGY_OWNER_LINKED_FILES = ['antigravity-oauth-token', 'installation_id', 'settings.json'];

// --- Kimi (native @moonshot-ai/kimi-code agent CLI) config-home (M-1, ADR-062) ---
// kimi RESPECTS KIMI_CODE_HOME as its config-home (KG-1 §1.1), so per-user isolation
// needs a dedicated home under the user tree (mirrors .codex — no HOME override).
// resolveProviderEnv (SL-5) imports THIS exact constant to set KIMI_CODE_HOME to
// userConfigDir(userId, KIMI_HOME_SUBDIR), so the config-home root now has a SINGLE
// source of truth here — the two files can no longer drift (the .kimi vs .kimi-code
// mismatch that broke isolation is impossible once both read this name). Inside the
// home: sessions/ (kimi writes <KIMI_CODE_HOME>/sessions/<id>/agents/<agentId>/wire.jsonl
// — natural subagent folding) and, FLAT in the home, config.toml / mcp.json /
// credentials/ / device_id / logs/. Governance (AGENTS.md) is a read-only COPY; kimi
// ingests it as SOFT reference only (enforced:false — no native bypass block), so the
// copy is best-effort here (the hard controls are cage + permission ceiling + env
// sanitize + per-user isolation, ADR-062 §2).
//
// LAYOUT CORRECTED 2026-08-01 (B-383). This comment used to claim mcp.json lived in a
// `.kimi-code/` SUBDIR of the home. It does not: kimi v0.28.1 reads the user-global
// file at <KIMI_CODE_HOME>/mcp.json, flat, and `.kimi-code/mcp.json` is resolved
// against the CWD instead. Verified against the bundled /mcp-config skill in
// dist/main.mjs and against the live tree (~/.nassaj-users/1/.kimi holds config.toml,
// credentials/, device_id and logs/ at its root; its .kimi-code/ is empty).
export const KIMI_HOME_SUBDIR = '.kimi';
// ADR-101/T-1374: Qwen Code resolves its user state below HOME/.qwen, so HOME is
// the isolation primitive — a platform contract rather than a vendor knob nobody
// has measured. (This comment once recorded the CLI as absent from the host;
// qwen-code 0.23.0 is installed here and its registry contract was measured
// 2026-09-07.) The layout constants live with the module that writes the file,
// exactly as CODEX_AGENTS_FILENAME and GEMINI_GOVERNANCE_FILENAME do, so the
// launcher and the provisioner cannot drift apart on where the tree is.
// Re-exported: this was the constant's public home before the registry landed.
export { QWEN_HOME_SUBDIR };
// ADR-101 records that Qwen reads QWEN.md and AGENTS.md. AGENTS.md is the
// filename the CLI's own user-level rule discovery looks for, and the neutral
// source is the same one Codex/Kimi/opencode copy.
const QWEN_AGENTS_FILENAME = 'AGENTS.md';
const KIMI_SESSIONS_SUBDIR = 'sessions';
// The OPERATOR's own kimi home, which really is `~/.kimi-code` (kimi's default when
// KIMI_CODE_HOME is unset). Used only to link the owner's existing credential into the
// isolated tree — it is NOT a subdir of a per-user home; conflating the two was B-383.
const KIMI_OPERATOR_HOME_SUBDIR = '.kimi-code';
const KIMI_AGENTS_FILENAME = 'AGENTS.md';

// kimi writes an API-key/OAuth credential + state to disk (KG-1 §1.1) ⇒ config-home
// isolation is mandatory (not conditional). The owner reuses the operator credential;
// a non-owner's own credential is a real 0600 file. The exact operator credential
// filename/path is confirmed at the G-KIMI-LIVE field gate — the owner symlink below
// is best-effort (no-op while the target is absent, e.g. before kimi is installed).
const KIMI_CREDENTIAL_FILES = ['auth.json'];

/**
 * Entries under the operator's ~/.hermes that every user SHARES by symlink.
 *
 * The split is credential vs configuration, and only these two names are on the
 * configuration side: `config.yaml` declares which model providers and endpoints
 * hermes may use (operator policy, ~15KB of it), and `bin/` holds the helper
 * executables it shells out to (uv, uvx, tirith). Everything else hermes writes
 * under that directory — auth.json, sessions/, state.db, the caches — is the
 * member's own and stays inside their tree.
 *
 * Nothing here carries an account, so a link cannot leak one. ensureSymlink is a
 * no-op when a name is absent, so an install without hermes provisions cleanly.
 */
const HERMES_SHARED_ENTRIES = ['config.yaml', 'bin'];

// --- OpenCode carrier config-home layout (GL-5, ADR-062) ---
// opencode's config-home is a REAL per-user dir (NOT the old whole-dir operator
// symlink), so its AGENTS.md is a per-user governance COPY — never a followed link into
// the shared fleet source (the write-through vector a full-access carrier turn could
// abuse). Only these NON-security shared subdirs stay symlinked to the operator
// (fleet-standard, the same sharing model as .claude/agents|skills).
const OPENCODE_SHARED_CONFIG_SUBDIRS = ['agent', 'command', 'skills'];
// The governance filename opencode ingests from its config-home. opencode OBEYS it at
// the ENFORCED codex/gemini tier, so the GL-5 spawn gate makes it fail-closed.
const OPENCODE_AGENTS_FILENAME = 'AGENTS.md';

// In-process guard so the (cheap) filesystem checks and the audit write only
// run once per user per server lifetime, even under concurrent spawns.
const provisioned = new Set();

/**
 * Applies one engine's governance decision for this user (owner decision
 * 2026-08-08). Called once per engine on each provisioning pass.
 *
 * THIS FUNCTION IS THE ANTI-REBOUND. Provisioning is the thing that PUTS the
 * governance material on disk, and it runs on every spawn (through
 * resolveProviderEnv) and after every ensureCodexGovernance repair. So an
 * exemption that only deleted files would last exactly until the user's next
 * turn, when this pass would silently write them back and re-govern someone who
 * had opted out — a switch that flips itself back is worse than no switch,
 * because the surface would keep reporting `exempt`.
 *
 * It RECONCILES rather than merely skipping: for an exempt engine it also
 * REMOVES any material still present. That covers the copies written before the
 * exemption existed, a write that raced the delete, and the crash window between
 * "row recorded" and "files removed" in the API's write path — after which the
 * disk converges to the table on the next pass without anyone re-issuing the
 * request.
 *
 * unlink(2), never a recursive remove and never a follow: it drops the directory
 * ENTRY, so claude's per-user SYMLINK is removed while the operator's file
 * behind it is untouched, and a directory in that position fails loudly instead
 * of being deleted.
 *
 * @param {Set<string>} exemptions channel ids this user has exempted
 * @param {string} channelId the engine's id in the exemption table
 * @param {string[]} materialPaths every path that IS this engine's governance
 * @param {() => void} materialize establishes the material when governed
 */
function reconcileEngineGovernance(exemptions, channelId, materialPaths, materialize) {
  if (!exemptions.has(channelId)) {
    materialize();
    return;
  }

  for (const target of materialPaths) {
    try {
      fs.unlinkSync(target);
      console.log('[provision] governance material removed (user exemption)', {
        channelId,
        target,
      });
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        console.error('[provision] could not remove exempted governance material', {
          channelId,
          target,
          error: err?.message || String(err),
        });
      }
    }
  }
}

/**
 * Forgets the in-process "already provisioned" flag for a user so the NEXT
 * provisionUserDirs(userId) performs a full (non-short-circuited) pass. Used by
 * the fail-closed Codex governance guard to FORCE a repair pass when a governance
 * symlink has gone missing after the user was already provisioned this lifetime
 * (the guard alone would otherwise no-op). No-op for empty ids.
 *
 * @param {string|number} userId
 */
export function invalidateProvisioned(userId) {
  if (userId === null || userId === undefined || userId === '') {
    return;
  }
  provisioned.delete(String(userId));
}

/** Root of all per-user isolated config trees. */
function usersRoot() {
  return path.join(os.homedir(), '.nassaj-users');
}

/**
 * Absolute path to a user's isolated config subtree.
 * @param {string|number} userId
 * @param {string} [sub] subdirectory under the user root (e.g. '.claude'); ''
 *   returns the user root itself.
 * @returns {string}
 */
export function userConfigDir(userId, sub = '') {
  const base = path.join(usersRoot(), String(userId));
  return sub ? path.join(base, sub) : base;
}

/** Creates a directory (recursive) with restrictive mode if it does not exist. */
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return true;
  }
  return false;
}

/**
 * Creates a symlink target<-link if `target` exists and `link` is not already
 * present. Never throws on a pre-existing link or a missing target — shared
 * resources are optional and must not block provisioning.
 */
function ensureSymlink(target, link) {
  try {
    if (!fs.existsSync(target)) {
      return;
    }
    if (fs.existsSync(link) || isSymlink(link)) {
      return;
    }
    fs.symlinkSync(target, link);
  } catch (err) {
    // A pre-existing dangling link or race is non-fatal; log and continue.
    console.error('[provision] symlink failed', {
      link,
      error: err?.message || String(err),
    });
  }
}

/** True if `p` is a symlink (even if dangling). */
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Tightens permissions on `p` to `mode` if it exists as a REAL file/dir.
 * Symlinks are skipped on purpose: the owner's `.credentials.json` is a symlink
 * back to the operator's shared credential, and chmod-ing through it would
 * rewrite the operator file's mode. Never throws — hardening must not block
 * provisioning.
 */
function chmodIfPresent(p, mode) {
  try {
    if (isSymlink(p)) {
      return;
    }
    if (!fs.existsSync(p)) {
      return;
    }
    fs.chmodSync(p, mode);
  } catch (err) {
    console.error('[provision] chmod failed', {
      path: p,
      mode: mode.toString(8),
      error: err?.message || String(err),
    });
  }
}

/**
 * Applies restrictive permissions across a user's isolated tree: the user root
 * and every config subdir to 0700, and any present credential file to 0600.
 * Idempotent and safe to call on every provisioning pass; tolerant of missing
 * paths. Symlinked credentials are intentionally skipped (see chmodIfPresent).
 *
 * @param {string} userRoot absolute path to the user's isolated config root
 */
function hardenUserTree(userRoot) {
  chmodIfPresent(userRoot, DIR_MODE);

  for (const sub of ['.claude', '.gemini', '.codex', KIMI_HOME_SUBDIR, QWEN_HOME_SUBDIR]) {
    chmodIfPresent(path.join(userRoot, sub), DIR_MODE);
  }

  // kimi config-home subdirs to 0700, and any real (owner: symlink → skipped)
  // credential file to 0600. (B-MU-OS-PERM, ADR-023.) `.kimi-code/` is still hardened
  // when present because older trees have one (B-383 stopped creating it), and a
  // stray 0755 dir under a member home is worth closing either way.
  const kimiHome = path.join(userRoot, KIMI_HOME_SUBDIR);
  for (const sub of [KIMI_SESSIONS_SUBDIR, KIMI_OPERATOR_HOME_SUBDIR]) {
    chmodIfPresent(path.join(kimiHome, sub), DIR_MODE);
  }
  for (const name of KIMI_CREDENTIAL_FILES) {
    chmodIfPresent(path.join(kimiHome, name), FILE_MODE);
  }

  // agy lives under .gemini/antigravity-cli; tighten that dir too (0700) so a
  // non-owner's freshly-written token dir is never group/world-listable.
  chmodIfPresent(path.join(userRoot, AGY_DIR), DIR_MODE);

  const claudeDir = path.join(userRoot, '.claude');
  for (const name of CLAUDE_CREDENTIAL_FILES) {
    chmodIfPresent(path.join(claudeDir, name), FILE_MODE);
  }

  // agy token: 0600 when a REAL file (a non-owner who ran `agy` and wrote their
  // own token). The owner's token is a symlink to the operator file and is
  // skipped by chmodIfPresent's isSymlink guard, so the shared file's mode is
  // never rewritten. (B-MU-OS-PERM, ADR-023.)
  const agyDir = path.join(userRoot, AGY_DIR);
  for (const name of AGY_CREDENTIAL_FILES) {
    chmodIfPresent(path.join(agyDir, name), FILE_MODE);
  }
}

/**
 * Removes a credential path that is a SYMLINK OUT of the user's own tree
 * (B-486 / ADR-105).
 *
 * Until this shipped, four provider blocks below linked the operator's real
 * credential into the tree of every account whose role is 'owner' — claude,
 * agy, codex and kimi. Two things were wrong with that, and the second is why
 * the links are actively reaped rather than merely no longer created:
 *
 *   1. "owner" here was `user.role === 'owner'`, NOT the bootstrap operator.
 *      This install has TWO owner-role accounts, so the convenience was already
 *      a credential-sharing channel, and any future promotion to owner would
 *      have silently inherited four providers' credentials at the next spawn.
 *   2. The channel was invisible to policy: it lives entirely outside
 *      `provider_sharing`, so a provider reading "Isolated" in the UI was still
 *      running on the operator's account. The settings screen even advertised
 *      it — "your credential is linked automatically as the owner".
 *
 * A link left in place would keep that true forever, since `ensureSymlink` is a
 * no-op on an existing path: provisioning alone would never replace it. So the
 * link is removed, and the account authenticates for itself.
 *
 * Only ever removes a SYMLINK — a real credential file in the user's tree is
 * their own and is never touched. Never throws: provisioning must not break a
 * spawn, and a failure here leaves the previous (working) state intact.
 *
 * @param {string} credentialPath
 */
function unlinkForeignCredential(credentialPath) {
  try {
    if (!fs.lstatSync(credentialPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return;
    }
    fs.unlinkSync(credentialPath);
    console.log('Removed operator credential link from user tree (B-486)', { credentialPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('Could not remove operator credential link', { credentialPath, error: message });
  }
}

/**
 * Ensures the isolated config tree + shared symlinks exist for a user.
 * Idempotent and safe under concurrency.
 *
 * @param {string|number} userId authenticated user id
 */
export function provisionUserDirs(userId) {
  if (userId === null || userId === undefined || userId === '') {
    return;
  }

  const key = String(userId);
  if (provisioned.has(key)) {
    return;
  }

  const home = os.homedir();
  const userRoot = userConfigDir(userId, '');
  let createdRoot = false;

  // Read ONCE per pass, not per engine: this runs on the spawn path, so five
  // probes where one query does is a cost paid on every turn. An unreadable
  // database yields an empty Set — i.e. every engine governed (fail-closed).
  const exemptions = listGovernanceExemptions(userId);

  try {
    createdRoot = ensureDir(userRoot);

    // --- Claude (isolated credentials + shared conversations/instructions) ---
    const claudeDir = path.join(userRoot, '.claude');
    ensureDir(claudeDir);
    ensureSymlink(path.join(home, '.claude', 'projects'), path.join(claudeDir, 'projects'));

    // claude's instruction channel — A LINK, NOT A COPY, deliberately (ADR-093
    // §4.1/§9): the coordinator's instructions must stay live rather than freeze
    // into a per-user snapshot. The exemption therefore removes the LINK, which
    // de-governs THIS user only; unlink never follows, so ~/.claude/CLAUDE.md
    // itself is untouched. `projects` above is conversation data, not
    // governance, so it is linked either way.
    reconcileEngineGovernance(
      exemptions,
      'claude',
      [path.join(claudeDir, 'CLAUDE.md'), path.join(claudeDir, 'NASSAJ.md')],
      () => {
        ensureSymlink(path.join(home, '.claude', 'CLAUDE.md'), path.join(claudeDir, 'CLAUDE.md'));
        ensureSymlink(path.join(home, '.claude', 'NASSAJ.md'), path.join(claudeDir, 'NASSAJ.md'));
      },
    );

    // Agent cards and skills are SHARED for ALL users (ADR-023 Decision 3:
    // MCP/tools/files are fully shared) — without these links a per-user
    // CLAUDE_CONFIG_DIR session cannot resolve the operator's custom agents
    // ("Agent type 'X' not found") or skills. settings.json is deliberately
    // NOT linked: each user keeps a personal settings file (theme prefs).
    ensureSymlink(path.join(home, '.claude', 'agents'), path.join(claudeDir, 'agents'));
    ensureSymlink(path.join(home, '.claude', 'skills'), path.join(claudeDir, 'skills'));
    ensureSymlink(path.join(home, '.claude', 'plugins'), path.join(claudeDir, 'plugins'));

    // NO credential is linked here for anyone (ADR-105). Every user — owner
    // included — runs their own `claude login`. Any link left by the previous
    // owner-convenience behaviour is reaped.
    unlinkForeignCredential(path.join(claudeDir, '.credentials.json'));

    // --- agy home (.gemini): isolated credentials + governance ---
    const geminiDir = path.join(userRoot, '.gemini');
    ensureDir(geminiDir);

    // Neutral agy governance (T-1185/B-390): materialize GEMINI.md into the user's
    // isolated .gemini as a real, read-only (0444) COPY of ~/.gemini/GEMINI.md — the
    // file agy actually ingests. PROVEN, not assumed: agy 1.1.9's own rule discovery
    // names "standalone GEMINI.md/AGENTS.md" files, and a live canary probe on
    // 2026-08-01 had `agy -p` recite ADR-018/T-1150/B-95 out of its loaded rules with
    // no tool use, while workspace-level GEMINI.md/AGENTS.md/.agents/rules went
    // unread. Without this the moment agy's sharing policy flips to "isolated" every
    // session launches with ZERO nassaj governance, silently (fail-open).
    // A COPY, NOT a symlink — identical threat model to Codex: agy runs with
    // --dangerously-skip-permissions (agy-cli.js:665), so a link to the shared source
    // could be written THROUGH and corrupt governance for every user on the node.
    // Best-effort (not fail-closed): agy has no blocking spawn guard yet — that is a
    // separate owner decision (T-1186) — so a failure is logged, never a dead launch.
    reconcileEngineGovernance(
      exemptions,
      'antigravity',
      [path.join(geminiDir, GEMINI_GOVERNANCE_FILENAME)],
      () =>
        materializeGeminiGovernance(geminiDir, {
          onError: err =>
            console.error('[provision-user-dirs] agy governance materialize failed', {
              userId,
              error: err instanceof Error ? err.message : String(err),
            }),
        }),
    );

    // --- agy / antigravity (isolated credentials + SHARED brain) ---
    // agy resolves its store under ~/.gemini/antigravity-cli relative to HOME;
    // under isolation resolveProviderEnv sets HOME to userRoot, so this dir is
    // exactly where agy reads/writes its token (and getBrainDir(userId) resolves
    // its brain — agy-cli.js:99-104).
    const operatorAgyDir = path.join(home, AGY_DIR);
    const userAgyDir = path.join(userRoot, AGY_DIR);
    ensureDir(userAgyDir);

    // brain is SHARED for EVERY user (owner and non-owner) — the mirror of
    // .claude/projects: a symlink to the operator's single brain store so all
    // users see the same agy conversations. getBrainDir(userId) computes
    // userRoot/.gemini/antigravity-cli/brain under isolation, which IS this link,
    // so the share is honored on read/write/discovery.
    ensureSymlink(
      path.join(operatorAgyDir, AGY_BRAIN_SUBDIR),
      path.join(userAgyDir, AGY_BRAIN_SUBDIR),
    );

    // NO token is linked here for anyone (ADR-105): each user OAuths their own
    // agy. The brain above stays shared — it is conversations, not credentials.
    for (const name of AGY_OWNER_LINKED_FILES) {
      unlinkForeignCredential(path.join(userAgyDir, name));
    }

    // --- Codex (isolated credentials + SHARED neutral governance) ---
    const codexDir = path.join(userRoot, '.codex');
    ensureDir(codexDir);

    // Neutral Codex governance (ADR-057 §5 — MANDATORY, fail-closed at spawn;
    // hardened 2026-07-12 remediation): materialize AGENTS.md into every user's
    // isolated CODEX_HOME as a real, read-only (0444) COPY of the neutral source so a
    // spawned Codex session reads nassaj's governance on launch — Codex (and opencode)
    // ingest $CODEX_HOME/AGENTS.md. The source is the SAME base the Claude
    // CLAUDE.md/NASSAJ.md links above use — ~/.claude/AGENTS.md, which bootstrap-node.sh
    // points at the governance repo's AGENTS.md on every fleet node: the build-agents NEUTRAL
    // output (no Claude-only mechanics — no /compact, session quotas, fable/opus model
    // maps, hooks or ultracode). A COPY, NOT a symlink: a Codex turn runs
    // danger-full-access, and a symlink to the shared fleet-wide source could be
    // written THROUGH and corrupt governance for EVERY user on the node; a per-user
    // copy caps the blast radius at that user's own next turn. "Governed" means the
    // copy's fingerprint MATCHES the source (identity, not mere existence); a missing,
    // drifted or subverted copy is rewritten here and re-checked by the fail-closed
    // spawn guard. materializeGovernanceCopy never throws and logs a blocked-sessions
    // marker when the neutral source is absent (owner decision 2026-07-12); the
    // spawn-time guard is the hard enforcement if this fast path fails.
    reconcileEngineGovernance(
      exemptions,
      'codex',
      [path.join(codexDir, CODEX_AGENTS_FILENAME)],
      () => materializeGovernanceCopy(codexDir),
    );

    // Persona reference material (T-909, best-effort — NOT governance): AGENTS.md's
    // own text points readers at `.agents/agents.md` (relative to itself) for each
    // agent's full persona. Antigravity gets this from ~/.claude/.agents/agents.md
    // directly; Codex never had a materialized copy at $CODEX_HOME/.agents/agents.md,
    // so a coordinator turn following that reference found it missing and reported it
    // as a limitation. Mirrors materializeGovernanceCopy's read-only COPY mechanics
    // but is deliberately non-blocking: see codex-governance-material.js.
    materializePersonaCopy(codexDir);

    // Coordinator delegate agents dir (T-886): pre-create the (empty)
    // $CODEX_HOME/agents dir so a coordinator-role launch materializes its read-only
    // delegate TOMLs into an existing 0700 dir. The TOMLs themselves are written at
    // LAUNCH (the resolved model is only known then), not during provisioning — this
    // just guarantees the directory exists and is owner-only.
    ensureDir(path.join(codexDir, CODEX_AGENTS_SUBDIR));

    // NO credential is linked here for anyone (ADR-105): each user runs their own
    // `codex login`. This one carried the sharpest edge of the four — the linked
    // file is an OAuth SEAT on a personal ChatGPT subscription, so the link made
    // one person's subscription serve several.
    unlinkForeignCredential(path.join(codexDir, 'auth.json'));

    // --- Kimi (M-1, ADR-062: isolated KIMI_CODE_HOME + soft governance COPY) ---
    // Mirrors the Codex block: a dedicated per-user config-home kimi keys all of its
    // state off (sessions/, .kimi-code/, credential). resolveProviderEnv (SL-5) sets
    // KIMI_CODE_HOME to this exact dir so an isolated user's kimi turns read/write here.
    const kimiHome = path.join(userRoot, KIMI_HOME_SUBDIR);
    ensureDir(kimiHome);

    // Neutral governance COPY (SL-1 primitive, aliased) at <KIMI_CODE_HOME>/AGENTS.md —
    // the SAME neutral source the Codex/Claude provisioning uses (~/.claude/AGENTS.md).
    // A real read-only (0444) COPY, never a symlink, for the write-through reason (a
    // full-access kimi turn must never reach the shared fleet source). UNLIKE Codex
    // this is BEST-EFFORT, not fail-closed: kimi's governance is SOFT (enforced:false,
    // no native mechanism to block a cwd AGENTS.md override — KG-1 §1.1/ADR-062 §2), so
    // a missing/failed copy must not block a launch. A non-blocking warning is logged.
    reconcileEngineGovernance(
      exemptions,
      'kimi',
      [path.join(kimiHome, KIMI_AGENTS_FILENAME)],
      () =>
        materializeVendorGovernanceCopy(kimiHome, KIMI_AGENTS_FILENAME, neutralGovernanceSource(), {
          mode: 0o444,
          onError: (err) => {
            console.warn('[Kimi] governance copy materialize failed (non-blocking)', {
              kimiHome,
              error: err instanceof Error ? err.message : String(err),
            });
          },
        }),
    );

    // Pre-create sessions/ (per-user session store — kimi writes
    // sessions/<id>/agents/<agentId>/wire.jsonl) as an owner-only (0700) dir. The
    // user-global mcp.json is FLAT in this home (B-383), so no config subdir is
    // created any more; the old `.kimi-code/` was never read by kimi and is left
    // in place on existing trees rather than removed under a live process.
    ensureDir(path.join(kimiHome, KIMI_SESSIONS_SUBDIR));

    // NO credential is linked here for anyone (ADR-105): each user authenticates
    // their own kimi, by device code or by storing their key.
    for (const name of KIMI_CREDENTIAL_FILES) {
      unlinkForeignCredential(path.join(kimiHome, name));
    }

    // --- Qwen (ADR-101: isolated credential + shared knowledge, ADR-105's split) ---
    // resolveProviderEnv points HOME at userRoot, so the CLI's ~/.qwen tree is
    // this real 0700 directory. That tree mixes the same two things Hermes' does:
    // the ACCOUNT (sessions/, projects/, usage/, the credential) and the SETUP
    // (skills, collective memory, nassaj's rules). The account stays per-user;
    // the knowledge is linked back, because a member launched without it is a
    // body that has never heard of nassaj and says nothing about it.
    const qwenHome = path.join(userRoot, QWEN_HOME_SUBDIR);
    ensureDir(qwenHome);

    // Collective memory — owner decision 2026-08-13: memory is SHARED, not
    // per-user («ذاكرة جماعية كما هو النظام مع باقي الاجساد»). The mirror of
    // .claude/projects and the agy brain: knowledge, not a credential.
    ensureSymlink(
      path.join(home, QWEN_HOME_SUBDIR, 'memories'),
      path.join(qwenHome, 'memories'),
    );

    // Skills are fleet-standard and non-security — the .claude/skills and
    // opencode agent|command|skills model. ensureSymlink no-ops where an older
    // pass already made this a REAL dir, so legacy trees keep what they have.
    ensureSymlink(
      path.join(home, QWEN_HOME_SUBDIR, 'skills'),
      path.join(qwenHome, 'skills'),
    );

    // Neutral governance COPY of the SAME source Codex/Kimi/opencode use. A COPY,
    // never a symlink, for the write-through reason: a full-access turn must not
    // reach the shared fleet source. BEST-EFFORT, not fail-closed — Qwen has no
    // spawn-time governance guard yet, and 'qwen' is not a channel in
    // GOVERNANCE_EXEMPTION_PROVIDERS, so there is no exemption to reconcile here
    // (adding one is an owner policy decision, not this block's to make). Without
    // the copy the body launches with zero nassaj rules — measured 2026-09-07:
    // "Loaded 0 global rule(s) / 0 project rule(s)".
    materializeVendorGovernanceCopy(qwenHome, QWEN_AGENTS_FILENAME, neutralGovernanceSource(), {
      mode: 0o444,
      onError: (err) => {
        console.warn('[Qwen] governance copy materialize failed (non-blocking)', {
          qwenHome,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });

    // settings.json is NOT linked: the operator's own copy carries the operator's
    // key in its `env` block, so a link would put one person's subscription in
    // every member's hands (ADR-105, and qwen-cli.js's own header invariant).
    // qwen-settings-material.js writes each member's registry at spawn from their
    // stored plan, with `envKey` naming the variable and the value arriving
    // through the child environment. A link left by an older pass is reaped.
    unlinkForeignCredential(path.join(qwenHome, QWEN_SETTINGS_FILENAME));

    // --- Hermes (ADR-105: isolated credential + shared configuration) ---
    // hermes resolves ~/.hermes from HOME, and that one directory mixes two very
    // different things: the account (auth.json, sessions/, state.db) and the
    // setup (config.yaml naming the model endpoints, bin/ holding helper tools
    // like uv/uvx). Isolating HOME separates them the right way round — the
    // account becomes per-user, and the setup is linked back so a member is not
    // asked to re-declare 15KB of endpoint configuration before their first run.
    //
    // auth.json is deliberately NOT linked: it is the credential, and each user
    // authenticates their own hermes (`hermes setup --portal`).
    const hermesDir = path.join(userRoot, '.hermes');
    ensureDir(hermesDir);
    for (const name of HERMES_SHARED_ENTRIES) {
      ensureSymlink(path.join(home, '.hermes', name), path.join(hermesDir, name));
    }
    unlinkForeignCredential(path.join(hermesDir, 'auth.json'));

    // --- OpenCode (OC-07 + GL-5: isolated XDG_DATA_HOME data, REAL per-user CONFIG) ---
    // resolveProviderEnv points opencode's four XDG base dirs at this user tree.
    // DATA (auth.json + opencode.db) must be isolated: create the empty data dir
    // so opencode writes into it.
    ensureDir(path.join(userRoot, '.local', 'share', 'opencode'));
    ensureDir(path.join(userRoot, '.config'));

    // GL-5 (ADR-062): STOP the whole-dir governance symlink. `.config/opencode` used to
    // be a SINGLE symlink to the operator's ~/.config/opencode, which made THIS user's
    // opencode AGENTS.md a FOLLOWED link into the shared, fleet-wide tree — a full-access
    // carrier turn could write THROUGH it and corrupt governance for EVERY user on the
    // node (the exact write-through vector the 2026-07-12 Codex remediation closed). So
    // opencode's config-home is now a REAL per-user directory holding a real read-only
    // (0444) AGENTS.md governance COPY (+ the GL-2 opencode.json COPY below), with only
    // the NON-security shared subdirs (agent/command/skills — the same model as
    // .claude/agents|skills, NOT governance) individually symlinked to the operator.
    // MIGRATION: a legacy whole-dir symlink from a pre-GL-5 pass is removed (rmSync
    // unlinks the LINK — it never follows it to touch the shared operator tree) then
    // replaced by the real dir, so upgrading a node self-heals on the next pass.
    const opencodeConfigDir = path.join(userRoot, '.config', 'opencode');
    if (isSymlink(opencodeConfigDir)) {
      try {
        fs.rmSync(opencodeConfigDir, { force: true });
      } catch (err) {
        console.error('[provision] opencode legacy governance symlink removal failed', {
          opencodeConfigDir,
          error: err?.message || String(err),
        });
      }
    }
    ensureDir(opencodeConfigDir);

    // Shared, NON-security subdirs stay symlinked to the operator (fleet-standard agent
    // commands + skills; ~/.claude/skills also stays reachable since HOME is not
    // overridden for opencode). AGENTS.md and opencode.json are deliberately NOT among
    // these — those are per-user COPIES (governance + the glm provider block).
    for (const sub of OPENCODE_SHARED_CONFIG_SUBDIRS) {
      ensureSymlink(
        path.join(home, '.config', 'opencode', sub),
        path.join(opencodeConfigDir, sub),
      );
    }

    // Neutral governance COPY at <config>/opencode/AGENTS.md — a real read-only (0444)
    // COPY of the SAME neutral source Codex/Claude use (~/.claude/AGENTS.md), NEVER a
    // symlink (write-through invariant). opencode ingests AGENTS.md and OBEYS it at the
    // codex/gemini ENFORCED tier, so unlike kimi's SOFT copy this is FAIL-CLOSED at
    // spawn: the GL-5 gate (opencode-governance.ts ensureOpenCodeGovernance) re-verifies
    // the fingerprint and BLOCKS the carrier launch if it cannot be attested. This fast
    // path just establishes the copy; the spawn guard is the hard enforcement (mirrors
    // Codex's materialize-here + guard-at-spawn). It is what lets the governance badge
    // honestly report opencode enforced:true (GL-7).
    reconcileEngineGovernance(
      exemptions,
      'opencode',
      [path.join(opencodeConfigDir, OPENCODE_AGENTS_FILENAME)],
      () =>
        materializeVendorGovernanceCopy(
          opencodeConfigDir,
          OPENCODE_AGENTS_FILENAME,
          neutralGovernanceSource(),
          {
            mode: 0o444,
            onError: (err) => {
              console.error(
                '[OpenCode] governance copy materialize FAILED — carrier sessions BLOCKED',
                {
                  opencodeConfigDir,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
            },
          },
        ),
    );

    // GL-2 (ADR-062): materialize a governed per-user opencode.json 0444 carrying the
    // custom `glm` provider block (baseURL api.z.ai/api/anthropic + model catalog),
    // instead of the carrier relying on a followed operator symlink (opencode.json is
    // not produced today — §1.2 OCC-2). A real per-user COPY (never a symlink) so a
    // full-access opencode turn can only damage its OWN file (rewritten next spawn by
    // fingerprint), never write THROUGH to a shared source. The config dir is now a REAL
    // per-user directory (GL-5 above), so the write-through gate below always passes.
    if (fs.existsSync(opencodeConfigDir) && !isSymlink(opencodeConfigDir)) {
      materializeOpenCodeConfig(opencodeConfigDir, {
        callerId: userId,
        onError: (err) => {
          console.warn('[OpenCode] opencode.json materialize failed (non-blocking)', {
            opencodeConfigDir,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      });
    }

    // Tighten permissions every pass: mkdir's `mode` is masked by the process
    // umask, so enforce 0700 dirs / 0600 credential files explicitly. Idempotent
    // and cheap. (B-MU-OS-PERM, ADR-023 Decision 2.)
    hardenUserTree(userRoot);

    // Record provisioning once, on first creation of the user root.
    if (createdRoot) {
      auditLogDb.record('user_dirs_provisioned', {
        userId: Number.isInteger(Number(userId)) ? Number(userId) : null,
        metadata: { root: userRoot },
      });
    }

    provisioned.add(key);
  } catch (err) {
    // Do not mark as provisioned so a later spawn can retry.
    console.error('[provision] provisionUserDirs failed', {
      userId: key,
      error: err?.message || String(err),
    });
  }
}
