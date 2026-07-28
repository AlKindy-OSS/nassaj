/**
 * kimi-spawn-isolation.test.ts — KM-1 (ADR-062 §4.2, wave W3-A). Proves the Kimi
 * native agent launch seam (kimi-agent-cli.js) on the four load-bearing contracts,
 * WITHOUT a real kimi binary (the package is not installed — the seam is exercised
 * with a controlled baseEnv, dep spies, and a real throwaway child for the env read):
 *
 *   (A) ORDER — the mandatory pipeline runs in the exact order
 *       resolveProviderEnv → verifyVendorBinaryDigest → ensureVendorCliGovernance →
 *       mapPermissionModeToVendorFlags → resolveCagedLaunch → sanitizeVendorAgentEnv,
 *       with sanitize as the ABSOLUTE LAST step (M-3).
 *
 *   (B) CHILD ENV AFTER THE CAGE — a REAL child spawned with the seam's produced
 *       env has NO CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_* / *_BASE_URL (M-2/M-3 on
 *       the kimi path), while the benign env (PATH) and the TARGET KIMI_API_KEY
 *       survive. (Cage flag OFF here ⇒ the env handed to spawn IS the child's env;
 *       the cage-reinjection guard — no --setenv/--clearenv baking ANTHROPIC_* back
 *       in — is owned by W2-C's provider-cage regression test.)
 *
 *   (C) DIGEST DRIFT — an armed pin against a binary whose bytes do not match the
 *       root-of-trust REFUSES the launch (throws), before governance is even reached.
 *
 *   (D) GOVERNANCE MISSING — when nassaj governance cannot be attested the seam
 *       REFUSES the launch (throws VendorGovernanceMissingError).
 *
 * Runner: node:test + node:assert/strict via
 *   tsx --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Bootstrap — MUST run before importing any project module (DB singleton reads
// DATABASE_PATH on first use; provision/home helpers read os.homedir()/$HOME).
// ---------------------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-kimi-spawn-iso-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(path.join(sandboxHome, '.claude'), { recursive: true });
// Seed the neutral governance source (~/.claude/AGENTS.md) so the fail-closed
// governance gate can pass for the tests that expect a governed launch.
fs.writeFileSync(
  path.join(sandboxHome, '.claude', 'AGENTS.md'),
  '# AGENTS.md — neutral nassaj governance\nplatform-agnostic instructions.\n',
);
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Keep any module-level interval (imported services) from holding the runner alive.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = function patchedSetInterval(this: unknown, ...callArgs: unknown[]) {
  const timer = (realSetInterval as unknown as (...a: unknown[]) => NodeJS.Timeout)(...callArgs);
  if (typeof (timer as NodeJS.Timeout)?.unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }
  return timer;
} as typeof setInterval;

const {
  prepareKimiAgentLaunch,
  buildKimiAgentArgs,
  resolveKimiBinaryPath,
  KIMI_SIBLING_VENDOR_KEYS,
} = await import('./kimi-agent-cli.js');
const { sanitizeVendorAgentEnv } = await import('./services/isolation/sanitize-vendor-agent-env.js');
const { VendorBinaryIntegrityError } = await import('./services/isolation/vendor-binary-integrity.js');
const { VendorGovernanceMissingError } = await import('./services/isolation/vendor-cli-governance.js');

after(() => {
  globalThis.setInterval = realSetInterval;
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// A hostile parent env carrying the worst leaks + benign vars + the target key.
function hostileBaseEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    HOME: sandboxHome,
    LANG: 'en_US.UTF-8',
    // the leaks that MUST vanish from the child
    CLAUDE_CODE_OAUTH_TOKEN: 'sk-claude-subscription-oauth-SECRET',
    ANTHROPIC_API_KEY: 'sk-ant-SECRET',
    ANTHROPIC_BASE_URL: 'https://api.competitor.example/v1',
    OPENAI_BASE_URL: 'https://proxy.example',
    // sibling hosted-vendor key that must be stripped via extraDeny
    GLM_API_KEY: 'glm-sibling-SECRET',
    // the TARGET vendor key that MUST survive
    KIMI_API_KEY: 'kimi-target-key',
  };
}

// ---------------------------------------------------------------------------
// (A) Ordered seam — sanitize LAST
// ---------------------------------------------------------------------------
describe('kimi seam order — sanitizeVendorAgentEnv is the LAST step (M-3)', () => {
  it('runs the mandatory pipeline in order with sanitize last', () => {
    const calls: string[] = [];
    const prepared = prepareKimiAgentLaunch(
      { userId: 7, command: 'do a thing', model: 'kimi-k2.6', permissionMode: 'default', cwd: sandboxHome, baseEnv: hostileBaseEnv() },
      {
        resolveProviderEnv: (_uid: unknown, _p: unknown, baseEnv: Record<string, string>, mode: string) => {
          calls.push('resolveProviderEnv');
          assert.equal(mode, 'agent', 'kimi agent seam must resolve env in agent mode');
          return { ...baseEnv, KIMI_CODE_HOME: path.join(sandboxHome, '.kimi') };
        },
        verifyVendorBinaryDigest: (id: string, p: string) => {
          calls.push('verifyVendorBinaryDigest');
          assert.equal(id, 'kimi');
          return p;
        },
        ensureVendorCliGovernance: (id: string, home: string, _source: string, opts: { filename?: string }) => {
          calls.push('ensureVendorCliGovernance');
          assert.equal(id, 'kimi');
          assert.equal(opts?.filename, 'AGENTS.md');
          assert.ok(String(home).endsWith('.kimi'), 'governance home is the resolved KIMI_CODE_HOME');
          return { ok: true, vendorId: id, home, governancePath: path.join(home, 'AGENTS.md'), repaired: false };
        },
        mapPermissionModeToVendorFlags: (id: string) => {
          calls.push('mapPermissionModeToVendorFlags');
          assert.equal(id, 'kimi');
          return { flags: ['--auto'], network: false, fullAccess: false, ceiling: 'workspace' };
        },
        resolveCagedLaunch: (spec: { mode?: string; cmd: string; args: string[] }) => {
          calls.push('resolveCagedLaunch');
          assert.equal(spec.mode, 'agent', 'cage must run in agent mode (SL-6)');
          return { cmd: spec.cmd, args: spec.args };
        },
        sanitizeVendorAgentEnv: (env: Record<string, string>, opts: { extraDeny?: readonly string[] }) => {
          calls.push('sanitizeVendorAgentEnv');
          return sanitizeVendorAgentEnv(env, opts);
        },
        neutralGovernanceSource: () => path.join(sandboxHome, '.claude', 'AGENTS.md'),
      },
    );

    assert.deepEqual(
      calls,
      [
        'resolveProviderEnv',
        'verifyVendorBinaryDigest',
        'ensureVendorCliGovernance',
        'mapPermissionModeToVendorFlags',
        'resolveCagedLaunch',
        'sanitizeVendorAgentEnv',
      ],
      'the seam must run in the ADR-062 §4.2 order',
    );
    assert.equal(calls.at(-1), 'sanitizeVendorAgentEnv', 'sanitize MUST be the final step');

    // The produced env is the sanitized one: leaks gone, target + benign survive.
    assert.ok(!('CLAUDE_CODE_OAUTH_TOKEN' in prepared.env), 'oauth token stripped');
    assert.ok(!('ANTHROPIC_API_KEY' in prepared.env), 'anthropic key stripped');
    assert.ok(!('ANTHROPIC_BASE_URL' in prepared.env), 'anthropic base url stripped');
    assert.ok(!('OPENAI_BASE_URL' in prepared.env), 'intrusive *_BASE_URL stripped');
    assert.ok(!('GLM_API_KEY' in prepared.env), 'sibling vendor key stripped via extraDeny');
    assert.equal(prepared.env.KIMI_API_KEY, 'kimi-target-key', 'target vendor key preserved');
    assert.equal(prepared.env.PATH, hostileBaseEnv().PATH, 'benign PATH preserved');
  });

  it('builds the KG-1 headless argv (-p / --output-format stream-json / --model / ceiling flags)', () => {
    const args = buildKimiAgentArgs({ command: 'hello', cliSessionId: 'sess-1', model: 'kimi-k2.6', permissionFlags: ['--auto'] });
    assert.deepEqual(args, ['-p', 'hello', '--output-format', 'stream-json', '--model', 'kimi-k2.6', '-c', 'sess-1', '--auto']);
    // ceiling flags come LAST
    assert.equal(args.at(-1), '--auto');
  });

  it('KIMI_SIBLING_VENDOR_KEYS covers the non-target hosted vendors', () => {
    assert.ok(KIMI_SIBLING_VENDOR_KEYS.includes('GLM_API_KEY'));
    assert.ok(KIMI_SIBLING_VENDOR_KEYS.includes('DEEPSEEK_API_KEY'));
    assert.ok(!KIMI_SIBLING_VENDOR_KEYS.includes('KIMI_API_KEY'), 'must never deny the target key');
  });

  it('resolveKimiBinaryPath honors KIMI_PATH override, else the bare bin', () => {
    assert.equal(resolveKimiBinaryPath({ KIMI_PATH: '/opt/kimi/bin/kimi' } as NodeJS.ProcessEnv), '/opt/kimi/bin/kimi');
    assert.equal(resolveKimiBinaryPath({} as NodeJS.ProcessEnv), 'kimi');
  });
});

// ---------------------------------------------------------------------------
// (B) Child env after the cage is clean (real child reads its real process.env)
// ---------------------------------------------------------------------------
describe('kimi child env after the cage — no ANTHROPIC_/CLAUDE_ leak (M-2/M-3)', () => {
  it('a real child spawned with the seam env sees no leaks but keeps the target key', () => {
    // userId=null ⇒ resolveProviderEnv returns baseEnv unchanged (no fs/provision);
    // governance materializes into ~/.kimi from the seeded neutral source; pin OFF.
    const prepared = prepareKimiAgentLaunch({
      userId: null,
      command: 'probe',
      model: 'kimi-k2.6',
      permissionMode: 'default',
      cwd: sandboxHome,
      baseEnv: hostileBaseEnv(),
    });

    // Prove the env produced by the seam is the ACTUAL child env: launch a real
    // node child with exactly this env and read back its process.env.
    const child = spawnSync(
      process.execPath,
      ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
      { env: prepared.env as NodeJS.ProcessEnv, encoding: 'utf8' },
    );
    assert.equal(child.status, 0, `probe child exited non-zero: ${child.stderr}`);
    const childEnv = JSON.parse(child.stdout) as Record<string, string>;

    for (const leak of ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_BASE_URL', 'GLM_API_KEY']) {
      assert.ok(!(leak in childEnv), `${leak} must NOT be visible to the kimi child`);
    }
    assert.equal(childEnv.KIMI_API_KEY, 'kimi-target-key', 'the target vendor key must reach the child');
    assert.ok(childEnv.PATH, 'benign PATH must reach the child');
  });
});

// ---------------------------------------------------------------------------
// (C) Digest drift refuses the launch (before governance)
// ---------------------------------------------------------------------------
describe('kimi digest pin — a drifted binary REFUSES the launch (SL-7/M-4)', () => {
  it('throws VendorBinaryIntegrityError when the pinned binary bytes do not match', () => {
    const fakeBin = path.join(sandbox, 'kimi-fake');
    fs.writeFileSync(fakeBin, 'not the approved kimi bytes\n');
    assert.throws(
      () =>
        prepareKimiAgentLaunch({
          userId: null,
          command: 'x',
          model: 'kimi-k2.6',
          cwd: sandboxHome,
          baseEnv: {
            ...hostileBaseEnv(),
            KIMI_PATH: fakeBin,
            NASSAJ_VENDOR_BINARY_PIN: 'true', // arm the pin
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof VendorBinaryIntegrityError, 'must be a VendorBinaryIntegrityError');
        assert.equal((err as InstanceType<typeof VendorBinaryIntegrityError>).vendorId, 'kimi');
        return true;
      },
      'a drifted kimi binary must refuse the launch',
    );
  });
});

// ---------------------------------------------------------------------------
// (D) Missing governance refuses the launch
// ---------------------------------------------------------------------------
describe('kimi governance gate — an unattested launch is REFUSED (SL-2)', () => {
  it('throws VendorGovernanceMissingError when governance cannot be established', () => {
    assert.throws(
      () =>
        prepareKimiAgentLaunch(
          { userId: null, command: 'x', model: 'kimi-k2.6', cwd: sandboxHome, baseEnv: hostileBaseEnv() },
          // Point the neutral source at a nonexistent file so governance cannot be
          // materialized/attested — the gate must refuse (fail-closed).
          { neutralGovernanceSource: () => path.join(sandbox, 'no-such-AGENTS.md') },
        ),
      (err: unknown) => {
        assert.ok(err instanceof VendorGovernanceMissingError, 'must be a VendorGovernanceMissingError');
        assert.equal((err as InstanceType<typeof VendorGovernanceMissingError>).code, 'governance_missing');
        return true;
      },
      'a missing governance source must refuse the launch',
    );
  });
});
