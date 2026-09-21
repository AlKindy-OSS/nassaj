/**
 * governance-preferences.integration.test — the per-engine governance switch
 * (owner decision 2026-08-08), tested end to end against a REAL database built
 * by the real migration path and a REAL per-user tree under a temp $HOME.
 *
 * WHY THIS SHAPE, AND NOT UNIT TESTS WITH FIXTURES
 * ------------------------------------------------
 * qa-critic's V2 struck an earlier acceptance criterion for passing even when
 * the logic underneath was dead, and the fleet's own lesson (2026-06-28,
 * `feedback_synthetic_fixtures_false_confidence`) is that green tests over
 * synthetic fixtures proved nothing about production. So every assertion here is
 * POSITIVE and made against artifacts the production code actually produced:
 * the real provisioning pass writes the files, the real repository stores the
 * row, the real gates are called.
 *
 * THE ACCEPTANCE TRIPLE (criterion 5). After an exemption, all three at once:
 *   (a) the file is GONE from the engine's home — not merely "not rewritten";
 *   (b) an audit_log row names the user, the engine and the actor;
 *   (c) the launch SUCCEEDS — an exemption is a choice, not a fault, so the
 *       fail-closed gate must let the turn through instead of blocking it.
 *
 * THE REBOUND (criterion 5, second half). The two paths that PUT governance on
 * disk are re-run after the exemption — the provisioning pass and the spawn
 * gate's repair — and the file must still be absent. This is the test that would
 * have caught "exempt lasts until your next turn": both of those paths write, and
 * both are reached on every spawn. provisionUserDirs is memoized per process, so
 * the rebound run invalidates first — otherwise the pass would no-op and the test
 * would pass while proving nothing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  closeConnection,
  getConnection,
  governanceExemptionsDb,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';
import { ensureCodexGovernance } from '@/modules/providers/list/codex/codex-governance.js';
import { ensureOpenCodeGovernance } from '@/modules/providers/list/opencode/opencode-governance.js';
import {
  governancePreferencesService,
  type GovernanceActorContext,
} from '@/modules/providers/services/governance-preferences.service.js';
import { resolveGovernanceMaterialPlan } from '@/modules/providers/services/provider-governance.service.js';
import {
  invalidateProvisioned,
  provisionUserDirs,
} from '@/services/isolation/provision-user-dirs.js';
import {
  _resetProviderSharingCache,
  setProviderSharingConfig,
} from '@/services/provider-sharing.js';
import { isGovernanceExempt } from '@/services/isolation/governance-exemption.js';
import type { LLMProvider } from '@/shared/types.js';

const GOVERNANCE_TEXT = '# nassaj neutral governance (test)\n\nrules...\n';
const GEMINI_TEXT = '# nassaj neutral governance for agy (test)\n';

type Harness = {
  home: string;
  userId: number;
  owner: GovernanceActorContext;
  member: GovernanceActorContext;
};

/**
 * A real database + a real temp $HOME. Node's os.homedir() honors $HOME on
 * POSIX, so every path the production code derives — the neutral sources, the
 * per-user tree under ~/.nassaj-users/<id> — lands inside the temp dir and the
 * operator's real home is never read or written.
 */
async function withHarness(runTest: (h: Harness) => void | Promise<void>): Promise<void> {
  const previousHome = process.env.HOME;
  const previousDatabasePath = process.env.DATABASE_PATH;
  const previousPlatform = process.env.VITE_IS_PLATFORM;

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-pref-'));
  process.env.HOME = tempRoot;
  delete process.env.VITE_IS_PLATFORM;

  closeConnection();
  _resetProviderSharingCache();
  process.env.DATABASE_PATH = path.join(tempRoot, 'auth.db');
  await initializeDatabase();
  // This suite asserts a per-user material plan. Make that prerequisite
  // explicit instead of inheriting whichever agy sharing mode another test
  // left in the module cache.
  setProviderSharingConfig({ agy: 'isolated' });

  // Neutral sources, in the same places the production resolvers look.
  fs.mkdirSync(path.join(tempRoot, '.claude'), { recursive: true });
  // Conversation data — NOT governance. Present so the claude test can prove the
  // exemption removes the instruction links and leaves this one alone
  // (ensureSymlink is a no-op when its target is absent, so without this the
  // assertion would be vacuous).
  fs.mkdirSync(path.join(tempRoot, '.claude', 'projects'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, '.claude', 'AGENTS.md'), GOVERNANCE_TEXT, 'utf8');
  fs.writeFileSync(path.join(tempRoot, '.claude', 'CLAUDE.md'), GOVERNANCE_TEXT, 'utf8');
  fs.writeFileSync(path.join(tempRoot, '.claude', 'NASSAJ.md'), GOVERNANCE_TEXT, 'utf8');
  fs.mkdirSync(path.join(tempRoot, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, '.gemini', 'GEMINI.md'), GEMINI_TEXT, 'utf8');

  const created = await userDb.createUser('gov-owner', 'pw-hash-not-a-password');
  const userId = Number(created.id);

  try {
    await runTest({
      home: tempRoot,
      userId,
      owner: { userId, role: 'owner', platformMode: false },
      member: { userId, role: 'user', platformMode: false },
    });
  } finally {
    invalidateProvisioned(userId);
    _resetProviderSharingCache();
    closeConnection();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDatabasePath === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabasePath;
    if (previousPlatform === undefined) delete process.env.VITE_IS_PLATFORM;
    else process.env.VITE_IS_PLATFORM = previousPlatform;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

/** Exists AS AN ENTRY — lstat, so a dangling symlink still counts as present. */
function entryExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

/** Rows written by the switch, newest first. */
function auditRows(action: string): { user_id: number; metadata: string }[] {
  return getConnection()
    .prepare('SELECT user_id, metadata FROM audit_log WHERE action = ? ORDER BY id DESC')
    .all(action) as { user_id: number; metadata: string }[];
}

/** Provisions from scratch, defeating the per-process memo. */
function provisionFresh(userId: number): void {
  invalidateProvisioned(userId);
  provisionUserDirs(userId);
}

// ---------------------------------------------------------------------------
// The store: an EXCEPTION list, so absence is the governed default.
// ---------------------------------------------------------------------------

test('migration creates governance_exemptions, and an empty table means governed', async () => {
  await withHarness(({ userId }) => {
    const columns = (
      getConnection().prepare('PRAGMA table_info(governance_exemptions)').all() as {
        name: string;
      }[]
    )
      .map((column) => column.name)
      .sort();
    assert.deepEqual(columns, ['created_at', 'expires_at', 'granted_by', 'provider', 'user_id']);

    // No rows have ever been written. Every engine reads governed — the default
    // is the ABSENCE of an exemption, not a value some code had to choose.
    for (const provider of ['codex', 'opencode', 'kimi', 'antigravity', 'claude']) {
      assert.equal(governanceExemptionsDb.isExempt(userId, provider), false);
      assert.equal(isGovernanceExempt(userId, provider), false);
    }
  });
});

test('an anonymous id and an unknown engine can never be exempt', async () => {
  await withHarness(({ userId }) => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    governanceExemptionsDb.grant(userId, 'codex', userId, expiresAt);
    // Anonymous has no tree of its own, so it holds no exemption…
    assert.equal(isGovernanceExempt(null, 'codex'), false);
    // …and an engine with no channel is not exemptible under any id.
    assert.equal(isGovernanceExempt(userId, 'hermes'), false);
    // The launch-path alias resolves to the stored channel id (agy → antigravity).
    governanceExemptionsDb.grant(userId, 'antigravity', userId, expiresAt);
    assert.equal(isGovernanceExempt(userId, 'agy'), true);
  });
});

// ---------------------------------------------------------------------------
// The acceptance triple + the rebound, per fail-closed engine.
// ---------------------------------------------------------------------------

test('codex: exempting removes the file, audits it, and the gate still launches', async () => {
  await withHarness(({ userId, owner }) => {
    provisionFresh(userId);

    const agentsPath = path.join(
      os.homedir(),
      '.nassaj-users',
      String(userId),
      '.codex',
      'AGENTS.md',
    );
    // Baseline: governed, and the material is really there (the state every user
    // on the node is in — the reason "just stop writing it" would do nothing).
    assert.ok(entryExists(agentsPath), 'baseline: codex governance must be materialized');
    assert.equal(ensureCodexGovernance(userId).ok, true);

    const channel = governancePreferencesService.setMode('codex' as LLMProvider, 'exempt', owner);
    assert.equal(channel.mode, 'exempt');
    assert.equal(channel.enforcement, 'fail-closed');
    assert.equal(channel.reason, undefined, 'no anomaly: the material really is gone');

    // (a) the file is GONE.
    assert.equal(entryExists(agentsPath), false, '(a) governance material must be removed');

    // (b) an audit row names the user, the engine and the actor's role.
    const rows = auditRows('governance_exemption_granted');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, userId);
    const metadata = JSON.parse(rows[0].metadata) as Record<string, unknown>;
    assert.equal(metadata.provider, 'codex');
    assert.equal(metadata.role, 'owner');
    assert.equal(metadata.resultMode, 'exempt');
    assert.equal('paths' in metadata, false, 'audit metadata must not expose host paths');

    // (c) the launch SUCCEEDS — exempt is a choice, not a fault.
    const gate = ensureCodexGovernance(userId);
    assert.equal(gate.ok, true, '(c) an exempt user must not be blocked');
    assert.equal(gate.exempt, true, 'the result must say WHY it passed');

    // REBOUND — the gate above runs the repair path when unattested; it must not
    // have rewritten the file it was told to leave alone.
    assert.equal(entryExists(agentsPath), false, 'rebound: the gate must not re-materialize');

    // REBOUND — a full provisioning pass (what every later spawn triggers).
    provisionFresh(userId);
    assert.equal(entryExists(agentsPath), false, 'rebound: provisioning must not re-materialize');
    assert.equal(ensureCodexGovernance(userId).ok, true);
  });
});

test('opencode: exempting removes the copy and the fail-closed gate stops throwing', async () => {
  await withHarness(({ userId, owner }) => {
    provisionFresh(userId);

    const agentsPath = path.join(
      os.homedir(),
      '.nassaj-users',
      String(userId),
      '.config',
      'opencode',
      'AGENTS.md',
    );
    assert.ok(entryExists(agentsPath), 'baseline: opencode governance must be materialized');
    assert.equal(ensureOpenCodeGovernance(userId).ok, true);

    governancePreferencesService.setMode('opencode' as LLMProvider, 'exempt', owner);
    assert.equal(entryExists(agentsPath), false, '(a) governance copy must be removed');

    // (c) The gate THROWS for an unattested launch; under an exemption it must
    // return instead — otherwise opting out would break the engine entirely.
    const gate = ensureOpenCodeGovernance(userId);
    assert.equal(gate.ok, true, '(c) an exempt carrier launch must not be blocked');
    assert.equal(gate.repaired, false, 'the gate must not self-heal an exempted home');

    // REBOUND across both writers.
    assert.equal(entryExists(agentsPath), false, 'rebound: the gate must not re-materialize');
    provisionFresh(userId);
    assert.equal(entryExists(agentsPath), false, 'rebound: provisioning must not re-materialize');
  });
});

test('kimi: exempting removes the copy and re-provisioning leaves it removed', async () => {
  await withHarness(({ userId, owner }) => {
    provisionFresh(userId);

    const agentsPath = path.join(
      os.homedir(),
      '.nassaj-users',
      String(userId),
      '.kimi',
      'AGENTS.md',
    );
    assert.ok(entryExists(agentsPath), 'baseline: kimi governance must be materialized');

    governancePreferencesService.setMode('kimi' as LLMProvider, 'exempt', owner);
    assert.equal(entryExists(agentsPath), false, '(a) governance copy must be removed');

    provisionFresh(userId);
    assert.equal(entryExists(agentsPath), false, 'rebound: provisioning must not re-materialize');
  });
});

test('claude: exempting deactivates the per-user LINK without touching the operator file', async () => {
  await withHarness(({ userId, owner, home }) => {
    provisionFresh(userId);

    const claudeDir = path.join(os.homedir(), '.nassaj-users', String(userId), '.claude');
    const link = path.join(claudeDir, 'CLAUDE.md');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), 'baseline: claude channel is a LINK, not a copy');

    const channel = governancePreferencesService.setMode('claude' as LLMProvider, 'exempt', owner);
    assert.equal(channel.mode, 'exempt');
    // The declared difference from the copy engines: no launch gate blocks
    // claude, so lifting governance changes what it reads and nothing else.
    assert.equal(channel.enforcement, 'none');

    assert.equal(entryExists(link), false, '(a) the per-user link must be removed');
    assert.equal(entryExists(path.join(claudeDir, 'NASSAJ.md')), false);
    // unlink(2) never follows: the operator's file behind the link survives.
    assert.equal(
      fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'),
      GOVERNANCE_TEXT,
      'the operator source must NEVER be written through',
    );
    // Conversation data is not governance and must be linked either way.
    assert.ok(entryExists(path.join(claudeDir, 'projects')));

    provisionFresh(userId);
    assert.equal(entryExists(link), false, 'rebound: provisioning must not re-link');
    assert.ok(entryExists(path.join(claudeDir, 'projects')), 'projects link must be restored');
  });
});

test('agy: exempting removes GEMINI.md and re-provisioning leaves it removed', async () => {
  await withHarness(({ userId, owner }) => {
    provisionFresh(userId);

    const geminiMd = path.join(
      os.homedir(),
      '.nassaj-users',
      String(userId),
      '.gemini',
      'GEMINI.md',
    );
    assert.ok(entryExists(geminiMd), 'baseline: agy governance must be materialized');

    const channel = governancePreferencesService.setMode(
      'antigravity' as LLMProvider,
      'exempt',
      owner,
    );
    assert.equal(channel.enforcement, 'best-effort', 'agy has no blocking gate yet (T-1186)');
    assert.equal(entryExists(geminiMd), false, '(a) governance copy must be removed');

    provisionFresh(userId);
    assert.equal(entryExists(geminiMd), false, 'rebound: provisioning must not re-materialize');
  });
});

// ---------------------------------------------------------------------------
// Re-binding, and the asymmetric authority.
// ---------------------------------------------------------------------------

test('re-binding to governed restores the material and is open to ANY role', async () => {
  await withHarness(({ userId, owner, member }) => {
    provisionFresh(userId);
    const agentsPath = path.join(
      os.homedir(),
      '.nassaj-users',
      String(userId),
      '.codex',
      'AGENTS.md',
    );

    governancePreferencesService.setMode('codex' as LLMProvider, 'exempt', owner);
    assert.equal(entryExists(agentsPath), false);

    // A plain member binds THEMSELVES back — no elevated role required. This is
    // the asymmetry: you may always put yourself under governance.
    const channel = governancePreferencesService.setMode('codex' as LLMProvider, 'governed', member);
    assert.equal(channel.mode, 'governed');
    assert.equal(channel.reason, undefined, 'restored material leaves no negative verdict');
    assert.ok(entryExists(agentsPath), 'the material must be re-established');
    assert.equal(ensureCodexGovernance(userId).exempt, undefined, 'the gate must attest again');

    const revoked = auditRows('governance_exemption_revoked');
    assert.equal(revoked.length, 1);
    assert.equal(JSON.parse(revoked[0].metadata).provider, 'codex');
  });
});

test('a plain member cannot lift governance, and platform mode refuses everyone', async () => {
  await withHarness(({ userId, member }) => {
    provisionFresh(userId);
    const agentsPath = path.join(
      os.homedir(),
      '.nassaj-users',
      String(userId),
      '.codex',
      'AGENTS.md',
    );

    assert.throws(
      () => governancePreferencesService.setMode('codex' as LLMProvider, 'exempt', member),
      /admin or owner/i,
      'the governed party must not exempt itself',
    );
    assert.ok(entryExists(agentsPath), 'a refused request must not touch the disk');
    assert.equal(governanceExemptionsDb.isExempt(userId, 'codex'), false, 'no row on refusal');

    // Platform mode answers every request as the first user (B-186), so `owner`
    // there means "whoever opened a socket" — no governance write under it.
    const platformOwner = { userId, role: 'owner', platformMode: true };
    assert.throws(
      () => governancePreferencesService.setMode('codex' as LLMProvider, 'exempt', platformOwner),
      /platform mode/i,
    );
    assert.ok(entryExists(agentsPath));
    assert.equal(governanceExemptionsDb.isExempt(userId, 'codex'), false);
  });
});

test('canManage reflects the role, and the read surface stays open to a member', async () => {
  await withHarness(({ userId, owner, member }) => {
    provisionFresh(userId);

    const ownerView = governancePreferencesService.listChannels(owner);
    assert.deepEqual(
      ownerView.map((channel) => channel.provider),
      ['codex', 'opencode', 'kimi', 'antigravity', 'claude'],
    );
    assert.ok(ownerView.every((channel) => channel.mode === 'governed'));
    assert.ok(ownerView.every((channel) => channel.canManage), 'an owner may flip every switch');

    const memberView = governancePreferencesService.listChannels(member);
    assert.equal(memberView.length, ownerView.length, 'a member SEES every channel');
    assert.ok(
      memberView.every((channel) => channel.canManage === false),
      'a member may flip none of them',
    );

    governancePreferencesService.setMode('kimi' as LLMProvider, 'exempt', owner);
    const after = governancePreferencesService.listChannels(member);
    assert.equal(after.find((channel) => channel.provider === 'kimi')?.mode, 'exempt');
    assert.equal(after.find((channel) => channel.provider === 'codex')?.mode, 'governed');
  });
});

// ---------------------------------------------------------------------------
// The removal plan is derived, never supplied — and refuses shared trees.
// ---------------------------------------------------------------------------

test('the material plan refuses an anonymous caller and every non-channel engine', async () => {
  await withHarness(() => {
    const anonymous = resolveGovernanceMaterialPlan('codex' as LLMProvider, null);
    assert.equal(anonymous.exemptible, false);
    assert.equal(anonymous.refusal, 'shared_tree');
    assert.deepEqual(anonymous.paths, [], 'an unexemptible plan must carry NO deletable path');

    const noChannel = resolveGovernanceMaterialPlan('hermes' as LLMProvider, 1);
    assert.equal(noChannel.exemptible, false);
    assert.equal(noChannel.refusal, 'no_mechanism');
    assert.deepEqual(noChannel.paths, []);
  });
});

test('every plan path lands inside the caller OWN tree', async () => {
  await withHarness(({ userId }) => {
    const userRoot = path.join(os.homedir(), '.nassaj-users', String(userId));
    for (const provider of ['codex', 'opencode', 'kimi', 'antigravity', 'claude']) {
      const plan = resolveGovernanceMaterialPlan(provider as LLMProvider, userId);
      assert.equal(plan.exemptible, true, `${provider} must be exemptible for an isolated user`);
      assert.equal(plan.scope, 'user');
      for (const target of plan.paths) {
        assert.ok(
          target.startsWith(`${userRoot}${path.sep}`),
          `${provider}: ${target} escapes the caller's tree`,
        );
      }
    }
  });
});
