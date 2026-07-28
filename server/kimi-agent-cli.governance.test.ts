/**
 * kimi-agent-cli.governance.test.ts — KM-5 (ADR-062 §4.2, W5-A).
 *
 * Dedicated governance-gate and seam-order tests for the Kimi native agent
 * launcher (`prepareKimiAgentLaunch` in kimi-agent-cli.js). Complements the
 * W3-A isolation test (kimi-spawn-isolation.test.ts) with precise assertions on:
 *
 *  (A) GOVERNANCE MISSING — VendorGovernanceMissingError thrown with the exact
 *      `code === 'governance_missing'` and `vendorId === 'kimi'` discriminators.
 *
 *  (B) DIGEST DRIFT BEFORE GOVERNANCE — VendorBinaryIntegrityError is thrown at
 *      pipeline step 2 (digest); governance (step 3) is never invoked. Proves the
 *      ordering contract: an attacker cannot slip a drifted binary past governance.
 *
 *  (C) SEAM ORDER — the six mandatory deps run in exactly the ADR-062 §4.2 order:
 *      resolveProviderEnv → verifyVendorBinaryDigest → ensureVendorCliGovernance
 *      → mapPermissionModeToVendorFlags → resolveCagedLaunch
 *      → sanitizeVendorAgentEnv (LAST).
 *
 *  (D) STATIC ENV CLEAN (static, no real child) — the env object returned by
 *      `prepareKimiAgentLaunch` has ZERO ANTHROPIC_x/CLAUDE_x/x_BASE_URL vars and
 *      ZERO sibling vendor keys (GLM_API_KEY / DEEPSEEK_API_KEY), while the
 *      target KIMI_API_KEY and benign PATH survive.
 *
 *  (E) BADGE HONESTY — the providerGovernanceService reports kimi as
 *      { enforced: false, mechanism: 'none' } (honest: no native bypass block,
 *      obedience is soft — KM-4 / ADR-062 §2).
 *
 * Runner:
 *   npx tsx --experimental-test-module-mocks --tsconfig server/tsconfig.json \
 *     --test server/kimi-agent-cli.governance.test.ts
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Bootstrap — MUST precede any project import.
// DB singleton reads DATABASE_PATH on first use; isolation helpers read $HOME.
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-kimi-gov-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });

// Seed the neutral governance source that the real seam reads.
const GOVERNANCE_TEXT = '# AGENTS.md — nassaj neutral governance\nPlatform-agnostic instructions.\n';
fs.writeFileSync(path.join(sandboxHome, '.claude', 'AGENTS.md'), GOVERNANCE_TEXT);

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Prevent module-level setIntervals (session manager, notification service) from
// keeping the test runner alive. Mirrors the pattern in kimi-spawn-isolation.test.ts.
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

const {
  prepareKimiAgentLaunch,
  KIMI_SIBLING_VENDOR_KEYS,
} = await import('./kimi-agent-cli.js');
const { sanitizeVendorAgentEnv } = await import('./services/isolation/sanitize-vendor-agent-env.js');
const {
  VendorGovernanceMissingError,
  GOVERNANCE_MISSING_CODE,
} = await import('./services/isolation/vendor-cli-governance.js');
const { VendorBinaryIntegrityError } = await import('./services/isolation/vendor-binary-integrity.js');

after(() => {
  globalThis.setInterval = realSetInterval;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Shared test helpers
// ---------------------------------------------------------------------------

/** A hostile parent env that carries all the leaks the seam must strip. */
function hostileBaseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: sandboxHome,
    LANG: 'en_US.UTF-8',
    // Claude subscription token — THE most dangerous leak.
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-claude-oauth-GOVERNANCE-TEST-SECRET',
    // Anthropic namespace leaks.
    ANTHROPIC_API_KEY: 'sk-ant-GOVERNANCE-SECRET',
    ANTHROPIC_BASE_URL: 'https://api.competitor.example/anthropic',
    ANTHROPIC_AUTH_TOKEN: 'bearer-GOVERNANCE-TOKEN',
    // Intrusive base-URL redirect.
    OPENAI_BASE_URL: 'https://proxy.example/openai',
    // Sibling vendor keys that must be stripped via extraDeny.
    GLM_API_KEY: 'glm-sibling-GOVERNANCE-SECRET',
    DEEPSEEK_API_KEY: 'deepseek-sibling-GOVERNANCE-SECRET',
    // The TARGET vendor key — must survive sanitization.
    KIMI_API_KEY: 'kimi-target-api-key-GOVERNANCE',
  };
}

/** All-pass dep stubs that let `prepareKimiAgentLaunch` succeed. */
function allPassDeps(
  kimiHome: string,
  agentsSourcePath: string,
): Record<string, unknown> {
  return {
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
    mapPermissionModeToVendorFlags: () => ({
      flags: ['--auto'],
      network: false,
      fullAccess: false,
      ceiling: 'workspace',
    }),
    resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => ({
      cmd: spec.cmd,
      args: spec.args,
    }),
    sanitizeVendorAgentEnv: (env: Record<string, string>, opts: unknown) =>
      sanitizeVendorAgentEnv(env, opts as object),
    neutralGovernanceSource: () => agentsSourcePath,
  };
}

// ---------------------------------------------------------------------------
// (A) Governance missing — VendorGovernanceMissingError with exact discriminators
// ---------------------------------------------------------------------------
describe('KM-5 governance gate — refused when neutral source is absent (A)', () => {
  it('throws VendorGovernanceMissingError with code governance_missing and vendorId kimi', () => {
    const kimiHome = path.join(sandbox, 'kimi-home-A');
    fs.mkdirSync(kimiHome, { recursive: true });

    let caught: unknown;
    try {
      prepareKimiAgentLaunch(
        {
          userId: null,
          command: 'probe',
          model: 'kimi-k2.6',
          permissionMode: 'default',
          cwd: sandboxHome,
          baseEnv: hostileBaseEnv(),
        },
        // Override the neutral source to point at a nonexistent file so the gate
        // cannot materialize / attest governance — must refuse fail-closed.
        {
          ...allPassDeps(kimiHome, path.join(sandboxHome, '.claude', 'AGENTS.md')),
          ensureVendorCliGovernance: undefined, // use the REAL gate
          neutralGovernanceSource: () => path.join(sandbox, 'DOES-NOT-EXIST-AGENTS.md'),
        } as Parameters<typeof prepareKimiAgentLaunch>[1],
      );
    } catch (err) {
      caught = err;
    }

    assert.ok(
      caught instanceof VendorGovernanceMissingError,
      `expected VendorGovernanceMissingError, got ${(caught as Error)?.constructor?.name}`,
    );
    const err = caught as InstanceType<typeof VendorGovernanceMissingError>;
    assert.equal(err.code, GOVERNANCE_MISSING_CODE, 'code must be governance_missing');
    assert.equal(err.vendorId, 'kimi', 'vendorId must be kimi');
    assert.ok(
      typeof err.governancePath === 'string' && err.governancePath.length > 0,
      'governancePath must be a non-empty string',
    );
    assert.ok(
      typeof err.reason === 'string',
      'reason discriminator must be present',
    );
  });

  it('reason is neutral_source_absent when the neutral governance file does not exist', () => {
    const kimiHome = path.join(sandbox, 'kimi-home-A2');
    fs.mkdirSync(kimiHome, { recursive: true });

    let caught: unknown;
    try {
      prepareKimiAgentLaunch(
        {
          userId: null,
          command: 'probe',
          model: 'kimi-k2.6',
          cwd: sandboxHome,
          baseEnv: hostileBaseEnv(),
        },
        {
          ...allPassDeps(kimiHome, path.join(sandboxHome, '.claude', 'AGENTS.md')),
          ensureVendorCliGovernance: undefined,
          neutralGovernanceSource: () => path.join(sandbox, 'no-source.md'),
        } as Parameters<typeof prepareKimiAgentLaunch>[1],
      );
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof VendorGovernanceMissingError);
    // GOVERNANCE_REASON.NEUTRAL_SOURCE_ABSENT = 'neutral_source_absent'
    assert.equal(
      (caught as InstanceType<typeof VendorGovernanceMissingError>).reason,
      'neutral_source_absent',
    );
  });
});

// ---------------------------------------------------------------------------
// (B) Digest drift is checked BEFORE governance
// ---------------------------------------------------------------------------
describe('KM-5 seam order — digest drift throws before governance is reached (B)', () => {
  it('VendorBinaryIntegrityError is thrown at step 2; governance fn is never invoked', () => {
    const kimiHome = path.join(sandbox, 'kimi-home-B');
    fs.mkdirSync(kimiHome, { recursive: true });
    // Write a "drifted" binary (wrong bytes for any real kimi).
    const fakeBin = path.join(sandbox, 'kimi-bin-B');
    fs.writeFileSync(fakeBin, 'these-are-not-approved-kimi-bytes');

    const governanceCalled: boolean[] = [];
    let caught: unknown;

    try {
      prepareKimiAgentLaunch(
        {
          userId: null,
          command: 'probe',
          model: 'kimi-k2.6',
          cwd: sandboxHome,
          baseEnv: {
            ...hostileBaseEnv(),
            KIMI_PATH: fakeBin,
            // Arm the integrity pin so verifyVendorBinaryDigest actually hashes.
            NASSAJ_VENDOR_BINARY_PIN: 'true',
          },
        },
        {
          // Use the REAL verifyVendorBinaryDigest (armed → mismatch → throws).
          resolveProviderEnv: (_uid: unknown, _p: unknown, baseEnv: Record<string, string>) =>
            ({ ...baseEnv, KIMI_CODE_HOME: kimiHome }),
          ensureVendorCliGovernance: () => {
            governanceCalled.push(true);
            return { ok: true, vendorId: 'kimi', home: kimiHome, governancePath: '', repaired: false };
          },
          mapPermissionModeToVendorFlags: () => ({
            flags: ['--auto'],
            network: false,
            fullAccess: false,
            ceiling: 'workspace',
          }),
          resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => ({
            cmd: spec.cmd,
            args: spec.args,
          }),
          sanitizeVendorAgentEnv: (env: Record<string, string>, opts: unknown) =>
            sanitizeVendorAgentEnv(env, opts as object),
          neutralGovernanceSource: () => path.join(sandboxHome, '.claude', 'AGENTS.md'),
        } as Parameters<typeof prepareKimiAgentLaunch>[1],
      );
    } catch (err) {
      caught = err;
    }

    assert.ok(
      caught instanceof VendorBinaryIntegrityError,
      `expected VendorBinaryIntegrityError, got ${(caught as Error)?.constructor?.name}`,
    );
    assert.equal(
      (caught as InstanceType<typeof VendorBinaryIntegrityError>).vendorId,
      'kimi',
    );
    assert.equal(
      governanceCalled.length,
      0,
      'governance must NOT be invoked when digest fails (step 2 < step 3)',
    );
  });
});

// ---------------------------------------------------------------------------
// (C) Seam order — sanitizeVendorAgentEnv is provably LAST
// ---------------------------------------------------------------------------
describe('KM-5 seam order — six steps run in ADR-062 §4.2 order, sanitize LAST (C)', () => {
  it('tracks the mandatory pipeline in the exact order, sanitize at position 6', () => {
    const kimiHome = path.join(sandbox, 'kimi-home-C');
    fs.mkdirSync(kimiHome, { recursive: true });

    const calls: string[] = [];
    const binaryPathStub = 'kimi';

    prepareKimiAgentLaunch(
      {
        userId: 7,
        command: 'test-command',
        model: 'kimi-k2.6',
        permissionMode: 'default',
        cwd: sandboxHome,
        baseEnv: hostileBaseEnv(),
      },
      {
        resolveProviderEnv: (_uid: unknown, _p: unknown, baseEnv: Record<string, string>) => {
          calls.push('1:resolveProviderEnv');
          return { ...baseEnv, KIMI_CODE_HOME: kimiHome };
        },
        verifyVendorBinaryDigest: (_id: unknown, p: string) => {
          calls.push('2:verifyVendorBinaryDigest');
          return p;
        },
        ensureVendorCliGovernance: (id: unknown, home: unknown) => {
          calls.push('3:ensureVendorCliGovernance');
          return {
            ok: true,
            vendorId: String(id),
            home: String(home),
            governancePath: path.join(String(home), 'AGENTS.md'),
            repaired: false,
          };
        },
        mapPermissionModeToVendorFlags: () => {
          calls.push('4:mapPermissionModeToVendorFlags');
          return { flags: ['--auto'], network: false, fullAccess: false, ceiling: 'workspace' };
        },
        resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => {
          calls.push('5:resolveCagedLaunch');
          return { cmd: binaryPathStub, args: spec.args };
        },
        sanitizeVendorAgentEnv: (env: Record<string, string>, opts: unknown) => {
          calls.push('6:sanitizeVendorAgentEnv');
          return sanitizeVendorAgentEnv(env, opts as object);
        },
        neutralGovernanceSource: () => path.join(sandboxHome, '.claude', 'AGENTS.md'),
      } as Parameters<typeof prepareKimiAgentLaunch>[1],
    );

    assert.deepEqual(
      calls,
      [
        '1:resolveProviderEnv',
        '2:verifyVendorBinaryDigest',
        '3:ensureVendorCliGovernance',
        '4:mapPermissionModeToVendorFlags',
        '5:resolveCagedLaunch',
        '6:sanitizeVendorAgentEnv',
      ],
      'all six steps must run in the ADR-062 §4.2 mandatory order',
    );
    assert.equal(
      calls.at(-1),
      '6:sanitizeVendorAgentEnv',
      'sanitize MUST be the absolute last step (SL-3/M-3)',
    );
    assert.equal(calls.indexOf('6:sanitizeVendorAgentEnv'), 5, 'sanitize is at index 5 (0-based)');
  });

  it('each step receives its own output as input (chaining contract)', () => {
    // Verifies that resolveProviderEnv output IS the env that sanitize receives,
    // not some other env — so nothing between resolve and spawn can re-introduce a leak.
    const kimiHome = path.join(sandbox, 'kimi-home-C2');
    fs.mkdirSync(kimiHome, { recursive: true });

    const RESOLVED_MARKER = 'MARKER_FROM_RESOLVE_STEP';
    let sanitizeReceivedMarker = false;

    prepareKimiAgentLaunch(
      {
        userId: null,
        command: 'x',
        model: 'kimi-k2.6',
        cwd: sandboxHome,
        baseEnv: hostileBaseEnv(),
      },
      {
        resolveProviderEnv: (_uid: unknown, _p: unknown, baseEnv: Record<string, string>) =>
          ({ ...baseEnv, KIMI_CODE_HOME: kimiHome, [RESOLVED_MARKER]: '1' }),
        verifyVendorBinaryDigest: (_id: unknown, p: string) => p,
        ensureVendorCliGovernance: () => ({
          ok: true, vendorId: 'kimi', home: kimiHome, governancePath: '', repaired: false,
        }),
        mapPermissionModeToVendorFlags: () => ({
          flags: [], network: false, fullAccess: false, ceiling: 'default',
        }),
        resolveCagedLaunch: (spec: { cmd: string; args: string[] }) => ({
          cmd: spec.cmd, args: spec.args,
        }),
        sanitizeVendorAgentEnv: (env: Record<string, string>, opts: unknown) => {
          sanitizeReceivedMarker = RESOLVED_MARKER in env;
          return sanitizeVendorAgentEnv(env, opts as object);
        },
        neutralGovernanceSource: () => path.join(sandboxHome, '.claude', 'AGENTS.md'),
      } as Parameters<typeof prepareKimiAgentLaunch>[1],
    );

    assert.equal(
      sanitizeReceivedMarker,
      true,
      'sanitize must receive the env that resolveProviderEnv produced',
    );
  });
});

// ---------------------------------------------------------------------------
// (D) Static env clean — no ANTHROPIC_*/CLAUDE_*/*_BASE_URL in produced env
// ---------------------------------------------------------------------------
describe('KM-5 static env clean — produced env has no leaks after the seam (D)', () => {
  it('strips all ANTHROPIC_*, CLAUDE_*, *_BASE_URL, and sibling vendor keys', () => {
    const kimiHome = path.join(sandbox, 'kimi-home-D');
    fs.mkdirSync(kimiHome, { recursive: true });

    const prepared = prepareKimiAgentLaunch(
      {
        userId: null,
        command: 'probe',
        model: 'kimi-k2.6',
        permissionMode: 'default',
        cwd: sandboxHome,
        baseEnv: hostileBaseEnv(),
      },
      allPassDeps(kimiHome, path.join(sandboxHome, '.claude', 'AGENTS.md')) as Parameters<
        typeof prepareKimiAgentLaunch
      >[1],
    );

    const env = prepared.env as Record<string, unknown>;

    // Claude subscription token — the worst possible leak.
    assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in env), 'CLAUDE_CODE_OAUTH_TOKEN must be stripped');

    // Full ANTHROPIC_ namespace.
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']) {
      assert.ok(!(key in env), `${key} must be stripped from kimi child env`);
    }

    // Intrusive base-URL redirect for another vendor.
    assert.ok(!('OPENAI_BASE_URL' in env), 'OPENAI_BASE_URL (*_BASE_URL) must be stripped');

    // Sibling hosted-vendor keys must be stripped via extraDeny.
    for (const siblingKey of KIMI_SIBLING_VENDOR_KEYS) {
      assert.ok(!(siblingKey in env), `${siblingKey} (sibling vendor key) must be stripped`);
    }

    // The TARGET vendor key and benign vars must survive.
    assert.equal(env['KIMI_API_KEY'], 'kimi-target-api-key-GOVERNANCE', 'KIMI_API_KEY must survive');
    assert.ok(env['PATH'], 'benign PATH must survive');
  });

  it('KIMI_CODE_HOME injected by resolveProviderEnv survives into the produced env', () => {
    const kimiHome = path.join(sandbox, 'kimi-home-D2');
    fs.mkdirSync(kimiHome, { recursive: true });

    const prepared = prepareKimiAgentLaunch(
      {
        userId: null,
        command: 'probe',
        model: 'kimi-k2.6',
        cwd: sandboxHome,
        baseEnv: hostileBaseEnv(),
      },
      allPassDeps(kimiHome, path.join(sandboxHome, '.claude', 'AGENTS.md')) as Parameters<
        typeof prepareKimiAgentLaunch
      >[1],
    );

    // KIMI_CODE_HOME is not in the sensitive-namespace denylist, so it must survive.
    assert.equal(
      (prepared.env as Record<string, string>)['KIMI_CODE_HOME'],
      kimiHome,
      'KIMI_CODE_HOME (injected by resolveProviderEnv) must reach the child env',
    );
  });
});

// ---------------------------------------------------------------------------
// (E) Badge honesty — kimi reports enforced:false / mechanism:'none' (KM-4)
// ---------------------------------------------------------------------------
describe('KM-5 badge honesty — kimi governance badge is honest (E)', () => {
  it('providerGovernanceService returns enforced:false, mechanism:none for kimi', async () => {
    // The governance service is stateless for providers without a filesystem gate,
    // so we can import it directly without a DB for this assertion.
    const { providerGovernanceService } = await import(
      '@/modules/providers/services/provider-governance.service.js'
    );
    const result = providerGovernanceService.getGovernance('kimi', 9999);

    assert.equal(
      result.enforced,
      false,
      'kimi must be enforced:false (no native bypass block — honest badge)',
    );
    assert.equal(
      result.mechanism,
      'none',
      'kimi must have mechanism:none (no runtime enforcement mechanism)',
    );
    // Status depends on disk state in the sandbox — we assert the mechanism fields only.
    assert.ok(
      result.status === 'governed' || result.status === 'ungoverned',
      'status must be a valid ProviderGovernanceStatus',
    );
  });
});
