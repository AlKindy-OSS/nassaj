/**
 * provisionUserDirs(userId) — per-user credential directory provisioning.
 *
 * Implements B-ISO-PROVISION (ADR-014): each user gets an isolated config tree
 * under ~/.nassaj-users/<userId>/ for Claude/Gemini/Codex credentials, while
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
 *       projects   -> ~/.gemini/projects         (shared, if present)
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

import { auditLogDb, userDb } from '../../modules/database/index.js';
import {
  materializeGovernanceCopy,
  materializePersonaCopy,
  neutralGovernanceSource,
} from './codex-governance-material.js';
import { CODEX_AGENTS_SUBDIR } from './codex-coordinator-agents.js';
// SL-1 neutral primitive (aliased — codex-governance-material re-exports a same-named
// single-arg Codex facade above). Used directly for the Kimi governance COPY (M-1).
import { materializeGovernanceCopy as materializeVendorGovernanceCopy } from './vendor-cli-governance-material.js';
import { materializeOpenCodeConfig } from './opencode-config-material.js';

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
// — natural subagent folding) and .kimi-code/ (holds mcp.json — a SUBDIR of the home,
// hence the root MUST be .kimi and not .kimi-code, else the mcp.json path would double
// to .kimi-code/.kimi-code/). Governance (AGENTS.md) is a read-only COPY; kimi ingests
// it as SOFT reference only (enforced:false — no native bypass block), so the copy is
// best-effort here (the hard controls are cage + permission ceiling + env sanitize +
// per-user isolation, ADR-062 §2). The exact root/subdir layout (sessions/,
// .kimi-code/mcp.json) is field-CONFIRMED at G-KIMI-LIVE; because both files read this
// shared constant, any later correction is a single-point edit.
export const KIMI_HOME_SUBDIR = '.kimi';
const KIMI_SESSIONS_SUBDIR = 'sessions';
const KIMI_CONFIG_SUBDIR = '.kimi-code';
const KIMI_AGENTS_FILENAME = 'AGENTS.md';

// kimi writes an API-key/OAuth credential + state to disk (KG-1 §1.1) ⇒ config-home
// isolation is mandatory (not conditional). The owner reuses the operator credential;
// a non-owner's own credential is a real 0600 file. The exact operator credential
// filename/path is confirmed at the G-KIMI-LIVE field gate — the owner symlink below
// is best-effort (no-op while the target is absent, e.g. before kimi is installed).
const KIMI_CREDENTIAL_FILES = ['auth.json'];

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

  for (const sub of ['.claude', '.gemini', '.codex', KIMI_HOME_SUBDIR]) {
    chmodIfPresent(path.join(userRoot, sub), DIR_MODE);
  }

  // kimi config-home subdirs (sessions/, .kimi-code/) to 0700, and any real (owner:
  // symlink → skipped) credential file to 0600. (B-MU-OS-PERM, ADR-023.)
  const kimiHome = path.join(userRoot, KIMI_HOME_SUBDIR);
  for (const sub of [KIMI_SESSIONS_SUBDIR, KIMI_CONFIG_SUBDIR]) {
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
 * True if `userId` is the bootstrap owner. The owner's isolated tree links back
 * to the operator's real Claude credential so the owner keeps working without a
 * separate login (the operator credential lives in ~/.claude/.credentials.json).
 * Defensive: any DB error is treated as "not owner" and never blocks
 * provisioning — credentials are optional, exactly like the other symlinks.
 *
 * @param {string|number} userId
 * @returns {boolean}
 */
function isOwnerUser(userId) {
  try {
    const numericId = Number(userId);
    if (!Number.isInteger(numericId)) {
      return false;
    }
    const user = userDb.getUserById(numericId);
    return user?.role === 'owner';
  } catch {
    return false;
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

  try {
    createdRoot = ensureDir(userRoot);

    // --- Claude (isolated credentials + shared conversations/instructions) ---
    const claudeDir = path.join(userRoot, '.claude');
    ensureDir(claudeDir);
    ensureSymlink(path.join(home, '.claude', 'projects'), path.join(claudeDir, 'projects'));
    ensureSymlink(path.join(home, '.claude', 'CLAUDE.md'), path.join(claudeDir, 'CLAUDE.md'));
    ensureSymlink(path.join(home, '.claude', 'NASSAJ.md'), path.join(claudeDir, 'NASSAJ.md'));

    // Agent cards and skills are SHARED for ALL users (ADR-023 Decision 3:
    // MCP/tools/files are fully shared) — without these links a per-user
    // CLAUDE_CONFIG_DIR session cannot resolve the operator's custom agents
    // ("Agent type 'X' not found") or skills. settings.json is deliberately
    // NOT linked: each user keeps a personal settings file (theme prefs).
    ensureSymlink(path.join(home, '.claude', 'agents'), path.join(claudeDir, 'agents'));
    ensureSymlink(path.join(home, '.claude', 'skills'), path.join(claudeDir, 'skills'));
    ensureSymlink(path.join(home, '.claude', 'plugins'), path.join(claudeDir, 'plugins'));

    // The bootstrap owner reuses the operator's real Claude credential even when
    // isolated, so the owner never has to re-login. Non-owner isolated users get
    // NO credential here on purpose: each must run their own `claude login`
    // (separate feature). ensureSymlink is a no-op if the target is missing.
    if (isOwnerUser(userId)) {
      ensureSymlink(
        path.join(home, '.claude', '.credentials.json'),
        path.join(claudeDir, '.credentials.json'),
      );
    }

    // --- Gemini (isolated; shared conversations if the root has them) ---
    const geminiDir = path.join(userRoot, '.gemini');
    ensureDir(geminiDir);
    ensureSymlink(path.join(home, '.gemini', 'projects'), path.join(geminiDir, 'projects'));

    // --- agy / antigravity (isolated credentials + SHARED brain) ---
    // agy resolves its store under ~/.gemini/antigravity-cli relative to HOME;
    // under isolation resolveProviderEnv sets HOME to userRoot, so this dir is
    // exactly where agy reads/writes its token (and getBrainDir(userId) resolves
    // its brain — agy-cli.js:99-104). It lives alongside gemini's projects/ under
    // the shared .gemini dir without collision (different subdir).
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

    // The bootstrap owner reuses the operator's real agy token (+ installation_id
    // / settings.json when present) so the isolated owner never re-authenticates.
    // Non-owner users get NO token here on purpose: each runs `agy` to OAuth their
    // own. ensureSymlink is a no-op when a target is missing.
    if (isOwnerUser(userId)) {
      for (const name of AGY_OWNER_LINKED_FILES) {
        ensureSymlink(path.join(operatorAgyDir, name), path.join(userAgyDir, name));
      }
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
    materializeGovernanceCopy(codexDir);

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

    // Since B-136 wired the per-user CODEX_HOME on the spawn path, the bootstrap
    // owner reuses the operator's real Codex credential (~/.codex/auth.json) so an
    // isolated owner never has to re-login — mirroring the .claude/.credentials.json
    // and agy antigravity-oauth-token owner links above. Non-owner isolated users get
    // NO credential here on purpose: each must run their own `codex login`.
    if (isOwnerUser(userId)) {
      ensureSymlink(
        path.join(home, '.codex', 'auth.json'),
        path.join(codexDir, 'auth.json'),
      );
    }

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
    materializeVendorGovernanceCopy(kimiHome, KIMI_AGENTS_FILENAME, neutralGovernanceSource(), {
      mode: 0o444,
      onError: (err) => {
        console.warn('[Kimi] governance copy materialize failed (non-blocking)', {
          kimiHome,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });

    // Pre-create sessions/ (per-user session store — kimi writes
    // sessions/<id>/agents/<agentId>/wire.jsonl) and .kimi-code/ (holds mcp.json,
    // written at launch by KM-4) so both exist as owner-only (0700) dirs.
    ensureDir(path.join(kimiHome, KIMI_SESSIONS_SUBDIR));
    ensureDir(path.join(kimiHome, KIMI_CONFIG_SUBDIR));

    // The bootstrap owner reuses the operator's real kimi credential so an isolated
    // owner never re-authenticates — mirroring the .claude/.credentials.json, agy
    // token, and .codex/auth.json owner links. Non-owner users get NO credential here:
    // each authenticates their own kimi. Best-effort: no-op while the operator target
    // is absent (exact path confirmed at G-KIMI-LIVE). ensureSymlink handles missing.
    if (isOwnerUser(userId)) {
      for (const name of KIMI_CREDENTIAL_FILES) {
        ensureSymlink(path.join(home, KIMI_CONFIG_SUBDIR, name), path.join(kimiHome, name));
      }
    }

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
    materializeVendorGovernanceCopy(opencodeConfigDir, OPENCODE_AGENTS_FILENAME, neutralGovernanceSource(), {
      mode: 0o444,
      onError: (err) => {
        console.error('[OpenCode] governance copy materialize FAILED — carrier sessions BLOCKED', {
          opencodeConfigDir,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });

    // GL-2 (ADR-062): materialize a governed per-user opencode.json 0444 carrying the
    // custom `glm` provider block (baseURL api.z.ai/api/anthropic + model catalog),
    // instead of the carrier relying on a followed operator symlink (opencode.json is
    // not produced today — §1.2 OCC-2). A real per-user COPY (never a symlink) so a
    // full-access opencode turn can only damage its OWN file (rewritten next spawn by
    // fingerprint), never write THROUGH to a shared source. The config dir is now a REAL
    // per-user directory (GL-5 above), so the write-through gate below always passes.
    if (fs.existsSync(opencodeConfigDir) && !isSymlink(opencodeConfigDir)) {
      materializeOpenCodeConfig(opencodeConfigDir, {
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
