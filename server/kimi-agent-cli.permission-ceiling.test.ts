/**
 * kimi-agent-cli.permission-ceiling.test.ts — KM-5 (ADR-062 §4.2 SL-4, W5-A).
 *
 * Tests for the kimi permission ceiling: the single enforcement chokepoint
 * `mapPermissionModeToVendorFlags('kimi', ...)` that both the WS and REST paths
 * funnel through before spawning the kimi native agent (SL-4, ADR-062 §4.1).
 *
 * THE CORE INVARIANT (from the spec): a client-chosen `bypassPermissions` mode
 * is CAPPED to the safe autonomous tier (`--auto`) unless an OPERATOR has opted
 * the whole deployment in via the SERVER env flag `KIMI_ALLOW_FULL_ACCESS=true`.
 * Network is OFF by default and can only be raised through a server flag, never
 * by a client. This mirrors the Codex B-169/T-884/T-895 ceiling pattern.
 *
 * Proves (all tests pure — no DB, no filesystem, no binary):
 *  (A) plan → --plan, network OFF (server-flag gates network even for plan).
 *  (B) default + acceptEdits → --auto, network OFF, fullAccess false.
 *  (C) bypassPermissions WITHOUT KIMI_ALLOW_FULL_ACCESS → --auto (capped, NOT --yolo).
 *  (D) bypassPermissions WITH KIMI_ALLOW_FULL_ACCESS=true → --yolo, network true, full.
 *  (E) KIMI_ALLOW_NETWORK=true raises network independently for plan/auto tiers.
 *  (F) Unknown/empty/null mode → --auto (fail-safe: unrecognized string never escalates).
 *  (G) Ceiling is wired through prepareKimiAgentLaunch: the produced args include the
 *      ceiling flags returned by mapPermissionModeToVendorFlags.
 *  (H) Per-user key isolation: KIMI_API_KEY injected by resolveProviderEnv survives
 *      into the produced env (ensuring the target vendor key reaches the child).
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/kimi-agent-cli.permission-ceiling.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Bootstrap — precede any project import so DB singleton resolves correctly.
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-kimi-perm-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
fs.writeFileSync(
  path.join(sandboxHome, '.claude', 'AGENTS.md'),
  '# AGENTS.md — nassaj neutral governance (permission ceiling test)\n',
);

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Prevent background timers from holding the runner alive.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(
  this: unknown,
  ...args: unknown[]
) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(
    ...args,
  );
  if (typeof (timer as NodeJS.Timeout)?.unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }
  return timer;
} as typeof setInterval;

const { mapPermissionModeToVendorFlags, SERVER_FLAGS } = await import(
  './services/isolation/vendor-cli-permissions.js'
);
const { prepareKimiAgentLaunch } = await import('./kimi-agent-cli.js');
const { sanitizeVendorAgentEnv } = await import('./services/isolation/sanitize-vendor-agent-env.js');

after(() => {
  globalThis.setInterval = realSetInterval;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// (A) plan mode — read-only ceiling, safest tier
// ---------------------------------------------------------------------------
describe('KM-5 permission ceiling — plan mode (A)', () => {
  it('plan → --plan flag, network OFF, fullAccess false, ceiling plan', () => {
    const result = mapPermissionModeToVendorFlags('kimi', 'plan', {});
    assert.deepEqual(result.flags, ['--plan']);
    assert.equal(result.network, false);
    assert.equal(result.fullAccess, false);
    assert.equal(result.ceiling, 'plan');
  });

  it('plan + KIMI_ALLOW_NETWORK=true → network true (server flag gates network)', () => {
    const result = mapPermissionModeToVendorFlags(
      'kimi',
      'plan',
      { [SERVER_FLAGS.KIMI_ALLOW_NETWORK]: 'true' },
    );
    assert.deepEqual(result.flags, ['--plan']);
    assert.equal(result.network, true, 'KIMI_ALLOW_NETWORK must enable network for plan tier');
    assert.equal(result.fullAccess, false);
  });
});

// ---------------------------------------------------------------------------
// (B) default + acceptEdits — safe workspace tier
// ---------------------------------------------------------------------------
describe('KM-5 permission ceiling — default and acceptEdits map to --auto (B)', () => {
  it('default → --auto, network OFF, fullAccess false, ceiling workspace', () => {
    const result = mapPermissionModeToVendorFlags('kimi', 'default', {});
    assert.deepEqual(result.flags, ['--auto']);
    assert.equal(result.network, false);
    assert.equal(result.fullAccess, false);
    assert.equal(result.ceiling, 'workspace');
  });

  it('acceptEdits → --auto (mirrors Codex mapping acceptEdits → workspace-write)', () => {
    const result = mapPermissionModeToVendorFlags('kimi', 'acceptEdits', {});
    assert.deepEqual(result.flags, ['--auto']);
    assert.equal(result.network, false);
    assert.equal(result.fullAccess, false);
    assert.equal(result.ceiling, 'workspace');
  });

  it('acceptEdits aliases (auto_edit, autoedit, accept_edits) all resolve to --auto', () => {
    for (const alias of ['auto_edit', 'autoedit', 'accept_edits']) {
      const result = mapPermissionModeToVendorFlags('kimi', alias, {});
      assert.deepEqual(result.flags, ['--auto'], `${alias} must map to --auto`);
      assert.equal(result.fullAccess, false, `${alias} must not grant full access`);
    }
  });
});

// ---------------------------------------------------------------------------
// (C) bypassPermissions without KIMI_ALLOW_FULL_ACCESS — capped to --auto
// ---------------------------------------------------------------------------
describe('KM-5 permission ceiling — bypass is CAPPED to --auto without server flag (C)', () => {
  it('bypassPermissions without KIMI_ALLOW_FULL_ACCESS → --auto (NOT --yolo)', () => {
    // This is the critical security invariant: a client picking the most
    // permissive mode cannot reach --yolo without an operator opt-in.
    const result = mapPermissionModeToVendorFlags(
      'kimi',
      'bypassPermissions',
      {
        // NO KIMI_ALLOW_FULL_ACCESS in env → must cap.
        UNRELATED: 'value',
      },
    );
    assert.deepEqual(
      result.flags,
      ['--auto'],
      'bypass without server flag must be capped to --auto, never --yolo',
    );
    assert.equal(result.fullAccess, false, 'fullAccess must be false when capped');
    assert.equal(result.ceiling, 'workspace', 'ceiling must be workspace when capped');
    assert.ok(!result.flags.includes('--yolo'), '--yolo must NOT be emitted without the server flag');
  });

  it('yolo alias → --auto when KIMI_ALLOW_FULL_ACCESS absent', () => {
    const result = mapPermissionModeToVendorFlags('kimi', 'yolo', {});
    assert.deepEqual(result.flags, ['--auto']);
    assert.equal(result.fullAccess, false);
  });

  it('KIMI_ALLOW_FULL_ACCESS=false does NOT grant full access', () => {
    for (const falsy of ['false', '0', 'no', 'off', '', ' ']) {
      const result = mapPermissionModeToVendorFlags(
        'kimi',
        'bypassPermissions',
        { [SERVER_FLAGS.KIMI_ALLOW_FULL_ACCESS]: falsy },
      );
      assert.deepEqual(
        result.flags,
        ['--auto'],
        `KIMI_ALLOW_FULL_ACCESS='${falsy}' must not grant full access`,
      );
      assert.equal(result.fullAccess, false);
    }
  });
});

// ---------------------------------------------------------------------------
// (D) bypassPermissions WITH KIMI_ALLOW_FULL_ACCESS=true → --yolo (full tier)
// ---------------------------------------------------------------------------
describe('KM-5 permission ceiling — full access ONLY behind the server flag (D)', () => {
  it('bypassPermissions + KIMI_ALLOW_FULL_ACCESS=true → --yolo, network true, full', () => {
    const result = mapPermissionModeToVendorFlags(
      'kimi',
      'bypassPermissions',
      { [SERVER_FLAGS.KIMI_ALLOW_FULL_ACCESS]: 'true' },
    );
    assert.deepEqual(result.flags, ['--yolo']);
    assert.equal(result.fullAccess, true, 'fullAccess must be true behind the server flag');
    assert.equal(result.network, true, 'network rides with full access');
    assert.equal(result.ceiling, 'full');
  });

  it('only the exact string "true" arms the full-access tier (isServerFlagOn contract)', () => {
    // The implementation checks env[key] === 'true' (strict equality).
    // Only 'true' arms the flag; '1', 'yes', 'on' do NOT — no broad truthy coercion.
    const result = mapPermissionModeToVendorFlags(
      'kimi',
      'bypassPermissions',
      { [SERVER_FLAGS.KIMI_ALLOW_FULL_ACCESS]: 'true' },
    );
    assert.deepEqual(result.flags, ['--yolo'], "KIMI_ALLOW_FULL_ACCESS='true' must grant --yolo");
    assert.equal(result.fullAccess, true);
  });

  it('"1", "yes", "on" do NOT arm the full-access tier (strict equality check)', () => {
    // Confirms that only the exact string 'true' is accepted — no broad truthy coercion.
    for (const nonTruthy of ['1', 'yes', 'on', 'TRUE', 'True']) {
      const result = mapPermissionModeToVendorFlags(
        'kimi',
        'bypassPermissions',
        { [SERVER_FLAGS.KIMI_ALLOW_FULL_ACCESS]: nonTruthy },
      );
      assert.deepEqual(
        result.flags,
        ['--auto'],
        `KIMI_ALLOW_FULL_ACCESS='${nonTruthy}' must NOT grant --yolo (only 'true' is accepted)`,
      );
      assert.equal(result.fullAccess, false, `fullAccess must be false for '${nonTruthy}'`);
    }
  });
});

// ---------------------------------------------------------------------------
// (E) KIMI_ALLOW_NETWORK independently raises network for non-full tiers
// ---------------------------------------------------------------------------
describe('KM-5 permission ceiling — KIMI_ALLOW_NETWORK flag (E)', () => {
  it('default + KIMI_ALLOW_NETWORK=true → --auto with network true', () => {
    const result = mapPermissionModeToVendorFlags(
      'kimi',
      'default',
      { [SERVER_FLAGS.KIMI_ALLOW_NETWORK]: 'true' },
    );
    assert.deepEqual(result.flags, ['--auto']);
    assert.equal(result.network, true);
    assert.equal(result.fullAccess, false, 'fullAccess must remain false');
  });

  it('capped bypass + KIMI_ALLOW_NETWORK=true → --auto with network true (still not --yolo)', () => {
    const result = mapPermissionModeToVendorFlags(
      'kimi',
      'bypassPermissions',
      { [SERVER_FLAGS.KIMI_ALLOW_NETWORK]: 'true' },
      // KIMI_ALLOW_FULL_ACCESS absent → cap to --auto
    );
    assert.deepEqual(result.flags, ['--auto']);
    assert.equal(result.network, true, 'KIMI_ALLOW_NETWORK enables network without --yolo');
    assert.equal(result.fullAccess, false);
  });
});

// ---------------------------------------------------------------------------
// (F) Unknown / null / empty modes — safe fail-over to default
// ---------------------------------------------------------------------------
describe('KM-5 permission ceiling — unknown mode never escalates (F)', () => {
  it('null permissionMode → --auto (safe default)', () => {
    const result = mapPermissionModeToVendorFlags('kimi', null as unknown as string, {});
    assert.deepEqual(result.flags, ['--auto']);
    assert.equal(result.fullAccess, false);
  });

  it('empty string → --auto', () => {
    const result = mapPermissionModeToVendorFlags('kimi', '', {});
    assert.deepEqual(result.flags, ['--auto']);
  });

  it('arbitrary unknown string → --auto (unrecognized client mode never escalates)', () => {
    // Note: 'yolo' and 'YOLO' ARE recognized aliases (case-insensitive normalization).
    // This test covers truly unrecognized strings that fall through to the safe default.
    for (const unknown of ['full', 'danger', '{"mode":"bypass"}', '💀', 'administrator']) {
      const result = mapPermissionModeToVendorFlags(
        'kimi',
        unknown,
        { [SERVER_FLAGS.KIMI_ALLOW_FULL_ACCESS]: 'true' },
      );
      // Even with the full-access server flag, an unknown mode string is NOT an alias
      // for bypass — it resolves to 'default' → --auto.
      assert.deepEqual(
        result.flags,
        ['--auto'],
        `unknown mode '${unknown}' must not escalate even with server flag`,
      );
    }
  });

  it('unknown vendorId → locked (no flags, network false, fullAccess false)', () => {
    const result = mapPermissionModeToVendorFlags(
      'unknown-vendor-xyz',
      'bypassPermissions',
      { [SERVER_FLAGS.KIMI_ALLOW_FULL_ACCESS]: 'true' },
    );
    assert.deepEqual(result.flags, []);
    assert.equal(result.network, false);
    assert.equal(result.fullAccess, false);
    assert.equal(result.ceiling, 'locked');
  });
});

// ---------------------------------------------------------------------------
// (G) Ceiling is wired through prepareKimiAgentLaunch (integration proof)
// ---------------------------------------------------------------------------
describe('KM-5 permission ceiling — wired through the full launch seam (G)', () => {
  it('prepareKimiAgentLaunch passes the ceiling flags to the produced argv', () => {
    const kimiHome = path.join(sandbox, 'kimi-home-G');
    fs.mkdirSync(kimiHome, { recursive: true });

    // Capture what mapPermissionModeToVendorFlags returns by spying; then verify
    // the returned flags appear in the produced argv.
    let capturedFlags: string[] = [];

    const prepared = prepareKimiAgentLaunch(
      {
        userId: null,
        command: 'ceiling-test',
        model: 'kimi-k2.6',
        permissionMode: 'plan', // expect --plan in argv
        cwd: sandboxHome,
        baseEnv: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: sandboxHome,
          KIMI_API_KEY: 'kimi-key-G',
        },
      },
      {
        resolveProviderEnv: (_uid: unknown, _p: unknown, baseEnv: Record<string, string>) =>
          ({ ...baseEnv, KIMI_CODE_HOME: kimiHome }),
        verifyVendorBinaryDigest: (_id: unknown, p: string) => p,
        ensureVendorCliGovernance: () => ({
          ok: true,
          vendorId: 'kimi',
          home: kimiHome,
          governancePath: path.join(kimiHome, 'AGENTS.md'),
          repaired: false,
        }),
        mapPermissionModeToVendorFlags: (
          id: string,
          mode: string,
          env: Record<string, string>,
        ) => {
          const result = mapPermissionModeToVendorFlags(id, mode, env);
          capturedFlags = [...result.flags];
          return result;
        },
        resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => ({
          cmd: spec.cmd,
          args: spec.args,
        }),
        sanitizeVendorAgentEnv: (env: Record<string, string>, opts: unknown) =>
          sanitizeVendorAgentEnv(env, opts as object),
        neutralGovernanceSource: () => path.join(sandboxHome, '.claude', 'AGENTS.md'),
      } as Parameters<typeof prepareKimiAgentLaunch>[1],
    );

    // The ceiling flags must appear in the produced argv.
    assert.deepEqual(capturedFlags, ['--plan'], 'plan mode must produce --plan');
    for (const flag of capturedFlags) {
      assert.ok(
        prepared.args.includes(flag),
        `ceiling flag '${flag}' must appear in the produced kimi argv`,
      );
    }
  });

  it('bypass WITHOUT server flag → --auto in argv (not --yolo)', () => {
    const kimiHome = path.join(sandbox, 'kimi-home-G2');
    fs.mkdirSync(kimiHome, { recursive: true });

    const prepared = prepareKimiAgentLaunch(
      {
        userId: null,
        command: 'bypass-test',
        model: 'kimi-k2.6',
        permissionMode: 'bypassPermissions',
        cwd: sandboxHome,
        baseEnv: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: sandboxHome,
          KIMI_API_KEY: 'kimi-key-G2',
          // No KIMI_ALLOW_FULL_ACCESS in base env.
        },
      },
      {
        resolveProviderEnv: (_uid: unknown, _p: unknown, baseEnv: Record<string, string>) =>
          ({ ...baseEnv, KIMI_CODE_HOME: kimiHome }),
        verifyVendorBinaryDigest: (_id: unknown, p: string) => p,
        ensureVendorCliGovernance: () => ({
          ok: true, vendorId: 'kimi', home: kimiHome, governancePath: '', repaired: false,
        }),
        mapPermissionModeToVendorFlags: (
          id: string,
          mode: string,
          env: Record<string, string>,
        ) => mapPermissionModeToVendorFlags(id, mode, env),
        resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => ({
          cmd: spec.cmd, args: spec.args,
        }),
        sanitizeVendorAgentEnv: (env: Record<string, string>, opts: unknown) =>
          sanitizeVendorAgentEnv(env, opts as object),
        neutralGovernanceSource: () => path.join(sandboxHome, '.claude', 'AGENTS.md'),
      } as Parameters<typeof prepareKimiAgentLaunch>[1],
    );

    assert.ok(prepared.args.includes('--auto'), '--auto must be in argv when bypass is capped');
    assert.ok(!prepared.args.includes('--yolo'), '--yolo must NOT be in argv without server flag');
  });
});

// ---------------------------------------------------------------------------
// (H) Per-user key isolation — KIMI_API_KEY isolated per userId
// ---------------------------------------------------------------------------
describe('KM-5 per-user key isolation — KIMI_API_KEY per userId (H)', () => {
  it('resolveProviderEnv injects per-user KIMI_API_KEY that survives into the env', () => {
    // Tests that the per-user key injected by resolveProviderEnv reaches
    // the produced env (the sanitizer preserves KIMI_* as the target namespace).
    const kimiHome = path.join(sandbox, 'kimi-home-H');
    fs.mkdirSync(kimiHome, { recursive: true });

    const USER_KIMI_KEY = 'kimi-per-user-key-USER-42';

    const prepared = prepareKimiAgentLaunch(
      {
        userId: 42,
        command: 'isolation-test',
        model: 'kimi-k2.6',
        cwd: sandboxHome,
        // baseEnv does NOT carry the user's key; resolveProviderEnv injects it.
        baseEnv: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: sandboxHome,
        },
      },
      {
        resolveProviderEnv: (uid: unknown, _p: unknown, baseEnv: Record<string, string>) => {
          // Simulate what the real resolveProviderEnv does: inject per-userId key.
          assert.equal(uid, 42, 'resolveProviderEnv must receive the correct userId');
          return {
            ...baseEnv,
            KIMI_CODE_HOME: kimiHome,
            KIMI_API_KEY: USER_KIMI_KEY,
          };
        },
        verifyVendorBinaryDigest: (_id: unknown, p: string) => p,
        ensureVendorCliGovernance: () => ({
          ok: true, vendorId: 'kimi', home: kimiHome, governancePath: '', repaired: false,
        }),
        mapPermissionModeToVendorFlags: () => ({
          flags: ['--auto'], network: false, fullAccess: false, ceiling: 'workspace',
        }),
        resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => ({
          cmd: spec.cmd, args: spec.args,
        }),
        sanitizeVendorAgentEnv: (env: Record<string, string>, opts: unknown) =>
          sanitizeVendorAgentEnv(env, opts as object),
        neutralGovernanceSource: () => path.join(sandboxHome, '.claude', 'AGENTS.md'),
      } as Parameters<typeof prepareKimiAgentLaunch>[1],
    );

    assert.equal(
      (prepared.env as Record<string, string>)['KIMI_API_KEY'],
      USER_KIMI_KEY,
      'the per-user KIMI_API_KEY must survive sanitization and reach the child env',
    );
  });

  it('different userId values produce isolated KIMI_CODE_HOME paths', () => {
    const homeUser1 = path.join(sandbox, 'kimi-home-H-user1');
    const homeUser2 = path.join(sandbox, 'kimi-home-H-user2');
    fs.mkdirSync(homeUser1, { recursive: true });
    fs.mkdirSync(homeUser2, { recursive: true });

    function launchForUser(userId: number, kimiHome: string) {
      return prepareKimiAgentLaunch(
        {
          userId,
          command: 'test',
          model: 'kimi-k2.6',
          cwd: sandboxHome,
          baseEnv: {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: sandboxHome,
          },
        },
        {
          resolveProviderEnv: (_uid: unknown, _p: unknown, baseEnv: Record<string, string>) => ({
            ...baseEnv,
            KIMI_CODE_HOME: kimiHome,
            KIMI_API_KEY: `kimi-key-user-${userId}`,
          }),
          verifyVendorBinaryDigest: (_id: unknown, p: string) => p,
          ensureVendorCliGovernance: () => ({
            ok: true, vendorId: 'kimi', home: kimiHome, governancePath: '', repaired: false,
          }),
          mapPermissionModeToVendorFlags: () => ({
            flags: ['--auto'], network: false, fullAccess: false, ceiling: 'workspace',
          }),
          resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => ({
            cmd: spec.cmd, args: spec.args,
          }),
          sanitizeVendorAgentEnv: (env: Record<string, string>, opts: unknown) =>
            sanitizeVendorAgentEnv(env, opts as object),
          neutralGovernanceSource: () => path.join(sandboxHome, '.claude', 'AGENTS.md'),
        } as Parameters<typeof prepareKimiAgentLaunch>[1],
      );
    }

    const p1 = launchForUser(1, homeUser1);
    const p2 = launchForUser(2, homeUser2);

    const env1 = p1.env as Record<string, string>;
    const env2 = p2.env as Record<string, string>;

    assert.notEqual(env1['KIMI_CODE_HOME'], env2['KIMI_CODE_HOME'],
      'different users must get different KIMI_CODE_HOME paths',
    );
    assert.notEqual(env1['KIMI_API_KEY'], env2['KIMI_API_KEY'],
      'different users must get different KIMI_API_KEY values',
    );
    assert.equal(env1['KIMI_CODE_HOME'], homeUser1);
    assert.equal(env2['KIMI_CODE_HOME'], homeUser2);
  });
});
