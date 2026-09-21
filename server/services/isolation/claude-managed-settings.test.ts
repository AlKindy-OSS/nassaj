/**
 * claude-managed-settings.test.ts — B-14 / T-1023
 *
 * Verifies that operator policy settings reach isolated user sessions AND that
 * personal preferences are never polluted by the operator's own theme/prefs.
 *
 * Two claims under test:
 *   1. Centrally-imposed policy (hooks, permissions, cleanupPeriodDays, …) reaches
 *      a user's isolated settings.json through mergePolicyIntoUserSettings().
 *   2. Personal keys (theme, language, …) survive untouched in the user's file and
 *      never appear in managed-settings.json or in the operator's settings.json.
 *
 * All paths are sandboxed in a tmpdir — never touches ~/.claude or
 * ~/.nassaj-users/. Runner: node:test / tsx (npm run test:server).
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------- Sandbox setup (must precede the module import) ----------

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-managed-settings-test-'));

/** Operator's .claude dir (mirrors ~/.claude in production). */
const operatorClaudeDir = path.join(sandbox, 'operator', '.claude');
/** First isolated user's .claude dir (mirrors ~/.nassaj-users/1/.claude). */
const user1ClaudeDir = path.join(sandbox, 'users', '1', '.claude');

/** Full operator settings.json — intentionally includes a personal `theme` key. */
const OPERATOR_SETTINGS = {
  hooks: {
    PreToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit|Bash',
        hooks: [
          {
            type: 'command',
            command: 'node /home/dev/governance-repo/hooks/zero-rule-guard.js',
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: 'Edit|Write|MultiEdit',
        hooks: [
          {
            type: 'command',
            command: 'node /home/dev/governance-repo/hooks/suggest-compact.js',
          },
        ],
      },
    ],
  },
  permissions: {
    allow: ['Read(/etc/**)', 'Bash(git status *)', 'Bash(npm *)'],
    deny: [],
  },
  cleanupPeriodDays: 30,
  enabledPlugins: { 'code-review@claude-plugins-official': true },
  effortLevel: 'medium',
  skipDangerousModePermissionPrompt: true,
  // PERSONAL — must never propagate to users or appear in managed-settings.json
  theme: 'light',
};

/** User's personal settings before any policy is applied. */
const USER1_PERSONAL = {
  theme: 'dark',   // must survive the merge
  language: 'ar',  // must survive the merge
};

// ---------- Module import ----------

const {
  POLICY_KEYS,
  readOperatorPolicySettings,
  syncManagedSettingsFile,
  mergePolicyIntoUserSettings,
  applyOperatorPolicy,
} = await import('./claude-managed-settings.js');

// ---------- Helpers ----------

function readJson(p: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

function mtimeMs(p: string): number {
  return fs.statSync(p).mtimeMs;
}

// ---------- Lifecycle ----------

before(() => {
  fs.mkdirSync(operatorClaudeDir, { recursive: true });
  fs.mkdirSync(user1ClaudeDir, { recursive: true });
  writeJson(path.join(operatorClaudeDir, 'settings.json'), OPERATOR_SETTINGS);
  writeJson(path.join(user1ClaudeDir, 'settings.json'), USER1_PERSONAL);
});

after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ============================================================
// readOperatorPolicySettings
// ============================================================

describe('readOperatorPolicySettings', () => {
  it('extracts exactly the POLICY_KEYS present in operator settings.json', () => {
    const policy = readOperatorPolicySettings(operatorClaudeDir);
    // Keys that exist in OPERATOR_SETTINGS AND are policy keys
    assert.ok(
      Object.prototype.hasOwnProperty.call(policy, 'hooks'),
      'hooks must be extracted',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(policy, 'permissions'),
      'permissions must be extracted',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(policy, 'cleanupPeriodDays'),
      'cleanupPeriodDays must be extracted',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(policy, 'enabledPlugins'),
      'enabledPlugins must be extracted',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(policy, 'effortLevel'),
      'effortLevel must be extracted',
    );
    assert.ok(
      Object.prototype.hasOwnProperty.call(policy, 'skipDangerousModePermissionPrompt'),
      'skipDangerousModePermissionPrompt must be extracted',
    );
  });

  it('NEVER includes the personal `theme` key', () => {
    const policy = readOperatorPolicySettings(operatorClaudeDir);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(policy, 'theme'),
      'theme is personal and must not appear in policy',
    );
  });

  it('all returned keys are declared POLICY_KEYS', () => {
    const policy = readOperatorPolicySettings(operatorClaudeDir);
    for (const key of Object.keys(policy)) {
      assert.ok(
        (POLICY_KEYS as readonly string[]).includes(key),
        `unexpected key "${key}" in extracted policy`,
      );
    }
  });

  it('returns {} when settings.json is missing', () => {
    const emptyDir = path.join(sandbox, 'no-settings', '.claude');
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.deepEqual(readOperatorPolicySettings(emptyDir), {});
  });

  it('returns {} when settings.json is malformed JSON', () => {
    const badDir = path.join(sandbox, 'bad-settings', '.claude');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'settings.json'), '{ not valid json }', 'utf8');
    assert.deepEqual(readOperatorPolicySettings(badDir), {});
  });
});

// ============================================================
// syncManagedSettingsFile
// ============================================================

describe('syncManagedSettingsFile', () => {
  const syncDir = path.join(sandbox, 'sync-operator', '.claude');

  before(() => {
    fs.mkdirSync(syncDir, { recursive: true });
    writeJson(path.join(syncDir, 'settings.json'), OPERATOR_SETTINGS);
  });

  it('creates managed-settings.json with exactly the policy content', () => {
    syncManagedSettingsFile(syncDir);
    const managedPath = path.join(syncDir, 'managed-settings.json');
    assert.ok(fs.existsSync(managedPath), 'managed-settings.json must be created');

    const managed = readJson(managedPath);
    // All policy keys from OPERATOR_SETTINGS must be present
    assert.deepEqual(managed.hooks, OPERATOR_SETTINGS.hooks);
    assert.deepEqual(managed.permissions, OPERATOR_SETTINGS.permissions);
    assert.equal(managed.cleanupPeriodDays, 30);
    assert.equal(managed.effortLevel, 'medium');
    assert.equal(managed.skipDangerousModePermissionPrompt, true);
  });

  it('NEVER writes the personal `theme` key to managed-settings.json', () => {
    const managed = readJson(path.join(syncDir, 'managed-settings.json'));
    assert.ok(
      !Object.prototype.hasOwnProperty.call(managed, 'theme'),
      'theme must be absent from managed-settings.json',
    );
  });

  it('is idempotent — second call skips the write (mtime unchanged)', () => {
    const managedPath = path.join(syncDir, 'managed-settings.json');
    const mtime1 = mtimeMs(managedPath);
    syncManagedSettingsFile(syncDir);
    const mtime2 = mtimeMs(managedPath);
    assert.equal(mtime1, mtime2, 'mtime must not change on a no-op sync');
  });

  it('updates managed-settings.json when operator adds a new policy key', () => {
    // Simulate operator enabling a new flag
    const updated = { ...OPERATOR_SETTINGS, extraKnownMarketplaces: ['https://custom.example'] };
    writeJson(path.join(syncDir, 'settings.json'), updated);

    syncManagedSettingsFile(syncDir);

    const managed = readJson(path.join(syncDir, 'managed-settings.json'));
    assert.deepEqual(
      managed.extraKnownMarketplaces,
      ['https://custom.example'],
      'new policy key must propagate to managed-settings.json',
    );
  });

  it('is non-blocking when settings.json is missing', () => {
    const missingDir = path.join(sandbox, 'sync-missing', '.claude');
    fs.mkdirSync(missingDir, { recursive: true });
    assert.doesNotThrow(() => syncManagedSettingsFile(missingDir));
  });
});

// ============================================================
// mergePolicyIntoUserSettings — the core B-14 claim
// ============================================================

describe('mergePolicyIntoUserSettings — policy reaches isolated user', () => {
  // Reset user settings before each sub-group.
  before(() => {
    writeJson(path.join(user1ClaudeDir, 'settings.json'), USER1_PERSONAL);
  });

  it('policy (hooks, permissions, cleanupPeriodDays) reaches the user settings.json', () => {
    const policy = readOperatorPolicySettings(operatorClaudeDir);
    mergePolicyIntoUserSettings(user1ClaudeDir, policy);

    const result = readJson(path.join(user1ClaudeDir, 'settings.json'));

    assert.deepEqual(result.hooks, OPERATOR_SETTINGS.hooks, 'hooks must match operator policy');
    assert.deepEqual(
      result.permissions,
      OPERATOR_SETTINGS.permissions,
      'permissions must match operator policy',
    );
    assert.equal(result.cleanupPeriodDays, 30, 'cleanupPeriodDays must match operator policy');
    assert.equal(result.effortLevel, 'medium', 'effortLevel must reach isolated user');
    assert.equal(
      result.skipDangerousModePermissionPrompt,
      true,
      'skipDangerousModePermissionPrompt must reach isolated user',
    );
  });

  it('personal preferences survive the merge — user theme/language unchanged', () => {
    // State: user1ClaudeDir was already merged in the previous test
    const result = readJson(path.join(user1ClaudeDir, 'settings.json'));
    assert.equal(result.theme, 'dark', 'user dark theme must survive (not inherit operator light)');
    assert.equal(result.language, 'ar', 'user language must be preserved');
  });

  it('operator settings.json is never modified during merge', () => {
    const before = readJson(path.join(operatorClaudeDir, 'settings.json'));
    const policy = readOperatorPolicySettings(operatorClaudeDir);
    mergePolicyIntoUserSettings(user1ClaudeDir, policy);
    const after = readJson(path.join(operatorClaudeDir, 'settings.json'));
    assert.deepEqual(before, after, 'operator settings.json must be unchanged');
  });

  it('creates settings.json for a user who has none (first-time provisioning)', () => {
    const newUserDir = path.join(sandbox, 'users', '2', '.claude');
    fs.mkdirSync(newUserDir, { recursive: true });
    // No settings.json exists yet

    const policy = readOperatorPolicySettings(operatorClaudeDir);
    mergePolicyIntoUserSettings(newUserDir, policy);

    assert.ok(
      fs.existsSync(path.join(newUserDir, 'settings.json')),
      'settings.json must be created',
    );
    const result = readJson(path.join(newUserDir, 'settings.json'));
    assert.deepEqual(result.hooks, OPERATOR_SETTINGS.hooks);
    assert.equal(result.cleanupPeriodDays, 30);
    // No personal keys since user has none yet
    assert.ok(!Object.prototype.hasOwnProperty.call(result, 'theme'));
  });

  it('is idempotent — running twice yields identical content (mtime unchanged)', () => {
    const settingsPath = path.join(user1ClaudeDir, 'settings.json');
    const policy = readOperatorPolicySettings(operatorClaudeDir);
    mergePolicyIntoUserSettings(user1ClaudeDir, policy);
    const mtime1 = mtimeMs(settingsPath);
    const content1 = fs.readFileSync(settingsPath, 'utf8');

    mergePolicyIntoUserSettings(user1ClaudeDir, policy);
    const mtime2 = mtimeMs(settingsPath);
    const content2 = fs.readFileSync(settingsPath, 'utf8');

    assert.equal(mtime1, mtime2, 'no-op merge must not touch the file');
    assert.equal(content1, content2, 'content must be identical after second merge');
  });

  it('policy update propagates on next spawn — no server restart required', () => {
    // Simulate operator adding a deny rule to settings.json
    const updatedOperator = {
      ...OPERATOR_SETTINGS,
      permissions: {
        allow: OPERATOR_SETTINGS.permissions.allow,
        deny: ['Bash(rm -rf *)'],
      },
    };
    writeJson(path.join(operatorClaudeDir, 'settings.json'), updatedOperator);

    const policy = readOperatorPolicySettings(operatorClaudeDir);
    mergePolicyIntoUserSettings(user1ClaudeDir, policy);

    const result = readJson(path.join(user1ClaudeDir, 'settings.json'));
    assert.deepEqual(
      result.permissions?.deny,
      ['Bash(rm -rf *)'],
      'updated deny rule must reach the user immediately',
    );
    // Restore operator settings for subsequent tests
    writeJson(path.join(operatorClaudeDir, 'settings.json'), OPERATOR_SETTINGS);
  });

  it('is non-blocking with empty policy (no write, no throw)', () => {
    const settingsPath = path.join(user1ClaudeDir, 'settings.json');
    const mtime1 = mtimeMs(settingsPath);
    assert.doesNotThrow(() => mergePolicyIntoUserSettings(user1ClaudeDir, {}));
    assert.equal(mtimeMs(settingsPath), mtime1, 'empty policy must not touch the file');
  });
});

// ============================================================
// applyOperatorPolicy — combined entry point
// ============================================================

describe('applyOperatorPolicy', () => {
  it('applies both layers using a sandboxed operatorHome — never reads real ~/.claude', () => {
    const operatorHome = path.join(sandbox, 'operator');
    const testUserDir = path.join(sandbox, 'users', '3', '.claude');
    fs.mkdirSync(testUserDir, { recursive: true });

    // operatorHome/.claude/settings.json is OPERATOR_SETTINGS (set in before())
    applyOperatorPolicy(testUserDir, operatorHome);

    // Layer 2 verified: policy in user settings.json
    const userResult = readJson(path.join(testUserDir, 'settings.json'));
    assert.deepEqual(userResult.hooks, OPERATOR_SETTINGS.hooks, 'hooks must reach user (Layer 2)');
    assert.equal(userResult.cleanupPeriodDays, 30);

    // Layer 1 verified: managed-settings.json updated
    const managed = readJson(path.join(operatorHome, '.claude', 'managed-settings.json'));
    assert.deepEqual(managed.hooks, OPERATOR_SETTINGS.hooks, 'hooks must be in managed-settings (Layer 1)');
    assert.ok(
      !Object.prototype.hasOwnProperty.call(managed, 'theme'),
      'theme must be absent from managed-settings.json',
    );
  });

  it('personal prefs preserved end-to-end through applyOperatorPolicy', () => {
    const operatorHome = path.join(sandbox, 'operator');
    const testUserDir = path.join(sandbox, 'users', '4', '.claude');
    fs.mkdirSync(testUserDir, { recursive: true });
    writeJson(path.join(testUserDir, 'settings.json'), { theme: 'dark', language: 'ar' });

    applyOperatorPolicy(testUserDir, operatorHome);

    const result = readJson(path.join(testUserDir, 'settings.json'));
    assert.equal(result.theme, 'dark', 'user theme must survive applyOperatorPolicy');
    assert.equal(result.language, 'ar', 'user language must survive applyOperatorPolicy');
  });

  it('is non-blocking when operatorHome does not exist', () => {
    const missingHome = path.join(sandbox, 'nonexistent-home');
    const testUserDir = path.join(sandbox, 'users', '5', '.claude');
    fs.mkdirSync(testUserDir, { recursive: true });
    assert.doesNotThrow(() => applyOperatorPolicy(testUserDir, missingHome));
  });
});
