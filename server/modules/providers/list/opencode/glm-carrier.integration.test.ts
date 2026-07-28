/**
 * glm-carrier.integration.test.ts — GL-10, W5-B (ADR-062).
 *
 * Integration test suite for the GLM OpenCode carrier path. Verifies that the
 * end-to-end sequence of guards that fires before a carrier spawn works correctly
 * in combination and against REAL fixtures derived from the actual module constants
 * (درس 2026-06-28: fixtures from real data, never synthetic).
 *
 * Scenarios covered (per the W5-B test-plan):
 *   1. Carrier env sanitization (GL-4 regression): sanitizeVendorAgentEnv strips
 *      ANTHROPIC_*, CLAUDE_*, GITHUB_TOKEN while the GLM_ target key survives.
 *   2. ${VAR}/{env:…} expansion + foreign-host rejection (GL-3 integration):
 *      The canonical opencode.json (from buildOpenCodeConfig) passes the guard;
 *      a config with ${VAR} → foreign host is refused.
 *   3. Config-fingerprint drift detection (GL-2 regression, "رفض المنجرف بالبصمة"):
 *      openCodeConfigMatches rejects a tampered file; materializeOpenCodeConfig
 *      restores it; a symlink is never accepted as governed.
 *   4. GLM key isolation in auth.json (GL-1): OpenCodeCredentialsWriter isolates
 *      the glm key under the provider id 'glm' in the same auth.json, without
 *      touching the 'anthropic' target.
 *   5. Cage mask: GLM key covered by the opencode entry (SL-6): CAGE_SHARED_CREDENTIALS
 *      .opencode encloses auth.json → the GLM key (a JSON entry inside it) is masked
 *      when a different provider is caged.
 *   6. Governance fail-closed (GL-5, "رفض غير المحكوم"): ensureOpenCodeGovernance
 *      throws VendorGovernanceMissingError when no neutral source exists.
 *   7. Binary digest deviation (SL-7/GL-6, "رفض انحراف digest"): verifyVendorBinaryDigest
 *      with enforced:true throws on a binary whose sha256 does not match the pin.
 *   8. Localhost server confinement (GL-6, "حصر localhost"): assertOpenCodeCarrierServerLocal
 *      accepts the canonical run args and refuses `serve` and non-loopback binds.
 *   9. Carrier flag OFF identity (NASSAJ_OPENCODE_CARRIER): the flag is absent from
 *      the process env by default; a missing opencode.json is a safe no-op.
 *
 * Bootstrap: sandboxed HOME + XDG_DATA_HOME (all modules imported AFTER the
 * overrides so every resolver sees the sandbox). userId=null short-circuits
 * resolveProviderEnv before any DB call — no database is opened.
 *
 * Pure: no real network, no real spawn, no real opencode binary.
 * Runner: node:test + node:assert/strict.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, beforeEach, describe, it } from 'node:test';

// ---------------------------------------------------------------------------
// Bootstrap: sandbox HOME + XDG_DATA_HOME before any project module is loaded.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..'); // list/opencode → modules → providers → server → root

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-carrier-int-'));
const sandboxHome = path.join(sandbox, 'home');
const sandboxData = path.join(sandbox, 'data');
fs.mkdirSync(sandboxHome, { recursive: true });
fs.mkdirSync(sandboxData, { recursive: true });

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_XDG_DATA = process.env.XDG_DATA_HOME;

// Override HOME first — os.homedir() reads $HOME on POSIX, so both the
// neutral governance source (~/.claude/AGENTS.md) and opencode config-home
// (~/.config/opencode) resolve inside the sandbox.
process.env.HOME = sandboxHome;
// Override XDG_DATA_HOME so the credentials writer stores auth.json in the sandbox.
process.env.XDG_DATA_HOME = sandboxData;

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_XDG_DATA === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = ORIGINAL_XDG_DATA;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// Dynamic imports AFTER env overrides are in place.
const { sanitizeVendorAgentEnv } = await import(
  '@/services/isolation/sanitize-vendor-agent-env.js'
);
const {
  assertOpenCodeBaseUrlAllowed,
  assertOpenCodeCarrierServerLocal,
  resolveOpenCodeConfigPath,
  ALLOWED_CARRIER_HOST,
} = await import('@/services/isolation/opencode-baseurl-guard.js');
const {
  buildOpenCodeConfig,
  serializeOpenCodeConfig,
  openCodeConfigMatches,
  materializeOpenCodeConfig,
  GLM_CARRIER_BASE_URL,
  OPENCODE_CONFIG_FILENAME,
} = await import('@/services/isolation/opencode-config-material.js');
const {
  verifyVendorBinaryDigest,
  VendorBinaryIntegrityError,
  PINNED_VENDOR_DIGESTS,
} = await import('@/services/isolation/vendor-binary-integrity.js');
const { CAGE_SHARED_CREDENTIALS } = await import(
  '@/services/isolation/provider-cage-wiring.js'
);
const { OpenCodeCredentialsWriter } = await import('./opencode-credentials.writer.js');
const {
  ensureOpenCodeGovernance,
  VendorGovernanceMissingError,
  GOVERNANCE_MISSING_CODE,
  OPENCODE_AGENTS_FILENAME,
} = await import('./opencode-governance.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Asserts a function throws without requiring the caller to write try/catch. */
function captureThrow(fn: () => unknown, context = ''): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail(`expected a throw${context ? ` (${context})` : ''}, but nothing was thrown`);
}

/** The GLM key and API key literals used across tests (safe for tests — never real keys). */
const SAMPLE_GLM_KEY = 'zai-test-sk-DO-NOT-USE-IN-PROD';
const SAMPLE_ANTHROPIC_KEY = 'sk-ant-test-DO-NOT-USE-IN-PROD';

// ---------------------------------------------------------------------------
// 1. Carrier env sanitization (GL-4 regression)
// ---------------------------------------------------------------------------

describe('GL-10 — carrier env sanitization (GL-4 regression)', () => {
  /** Hostile parent env: every namespace a leaked operator process could pass down. */
  function hostileCarrierParentEnv(): Record<string, string> {
    return {
      // --- Claude subscription and Anthropic credentials (MUST be stripped) ---
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-owner-subscription-SECRET',
      ANTHROPIC_API_KEY: 'sk-ant-SECRET',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'ant-auth-SECRET',
      ANTHROPIC_BEDROCK_BASE_URL: 'https://bedrock.example',
      CLAUDE_CONFIG_DIR: '/home/op/.claude',
      // --- Other harness secrets (MUST be stripped) ---
      GITHUB_TOKEN: 'ghp_SECRET',
      OPENAI_API_KEY: 'sk-openai-SECRET',
      GEMINI_API_KEY: 'gem-SECRET',
      // --- Intrusive base-URL redirect (MUST be stripped) ---
      SOME_VENDOR_BASE_URL: 'https://intruder.example',
      // --- Benign operational env (MUST survive) ---
      PATH: '/usr/bin:/bin',
      HOME: sandboxHome,
      LANG: 'en_US.UTF-8',
      XDG_DATA_HOME: sandboxData,
      XDG_CONFIG_HOME: path.join(sandboxHome, '.config'),
      // --- Carrier's own GLM key (MUST survive — explicit private key conjunct) ---
      GLM_API_KEY: 'zai-glm-carrier-key-KEPT',
    };
  }

  it('strips CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_* and GITHUB_TOKEN from the carrier env', () => {
    const clean = sanitizeVendorAgentEnv(hostileCarrierParentEnv());

    assert.equal(clean.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'Claude OAuth token must vanish (worst case)');
    assert.equal(clean.ANTHROPIC_API_KEY, undefined, 'ANTHROPIC_API_KEY must vanish');
    assert.equal(clean.ANTHROPIC_BASE_URL, undefined, 'ANTHROPIC_BASE_URL must vanish');
    assert.equal(clean.ANTHROPIC_AUTH_TOKEN, undefined, 'ANTHROPIC_AUTH_TOKEN must vanish');
    assert.equal(clean.ANTHROPIC_BEDROCK_BASE_URL, undefined);
    assert.equal(clean.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(clean.GITHUB_TOKEN, undefined);
    assert.equal(clean.OPENAI_API_KEY, undefined);
    assert.equal(clean.GEMINI_API_KEY, undefined);
    assert.equal(clean.SOME_VENDOR_BASE_URL, undefined, '*_BASE_URL must be stripped');
  });

  it('preserves operational env and the GLM_ carrier key after sanitization', () => {
    const clean = sanitizeVendorAgentEnv(hostileCarrierParentEnv());

    assert.equal(clean.PATH, '/usr/bin:/bin', 'PATH must survive');
    assert.equal(clean.HOME, sandboxHome, 'HOME must survive');
    assert.equal(clean.LANG, 'en_US.UTF-8');
    assert.equal(clean.XDG_DATA_HOME, sandboxData);
    assert.equal(clean.XDG_CONFIG_HOME, path.join(sandboxHome, '.config'));
    // The GLM key is the EXPLICIT private key (first conjunct of the compliance model).
    assert.equal(clean.GLM_API_KEY, 'zai-glm-carrier-key-KEPT',
      'GLM_ carrier key must survive sanitization');
  });

  it('never mutates the input env (returns a fresh copy)', () => {
    const parent = hostileCarrierParentEnv();
    const snapshot = { ...parent };
    sanitizeVendorAgentEnv(parent);
    assert.deepEqual(parent, snapshot, 'input env must be untouched');
  });
});

// ---------------------------------------------------------------------------
// 2. ${VAR}/{env:…} expansion + foreign-host rejection (GL-3 integration)
// ---------------------------------------------------------------------------

describe('GL-10 — canonical opencode.json passes the baseURL guard (GL-3 integration)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-baseurl-int-'));
    fs.mkdirSync(path.join(tempDir, 'opencode'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('the canonical opencode.json (from buildOpenCodeConfig) passes the guard unchanged', () => {
    // Real fixture: the SAME bytes that materializeOpenCodeConfig writes to disk.
    const configDir = path.join(tempDir, 'opencode');
    const canonical = serializeOpenCodeConfig(buildOpenCodeConfig());
    const configPath = path.join(configDir, OPENCODE_CONFIG_FILENAME);
    fs.writeFileSync(configPath, canonical, 'utf8');

    // Must not throw: the canonical config routes only to the approved host.
    assert.doesNotThrow(() => assertOpenCodeBaseUrlAllowed(configPath, process.env));
  });

  it('a config with ${VAR} pointing at the vetted host is ALLOWED (expansion before check)', () => {
    const configPath = path.join(tempDir, 'opencode', OPENCODE_CONFIG_FILENAME);
    // Use ${VAR} interpolation — opencode expands these before routing (OCC-2 condition).
    const config = JSON.stringify({
      provider: { glm: { npm: '@ai-sdk/anthropic', options: { baseURL: '${GLM_BASE_URL}' } } },
    });
    fs.writeFileSync(configPath, config, 'utf8');

    // The var resolves to the vetted carrier URL → allowed.
    assert.doesNotThrow(() =>
      assertOpenCodeBaseUrlAllowed(configPath, { GLM_BASE_URL: GLM_CARRIER_BASE_URL }));
  });

  it('a config with ${VAR} pointing at a FOREIGN host is REFUSED (expansion before check)', () => {
    const configPath = path.join(tempDir, 'opencode', OPENCODE_CONFIG_FILENAME);
    const config = JSON.stringify({
      provider: { glm: { npm: '@ai-sdk/anthropic', options: { baseURL: '${GLM_BASE_URL}' } } },
    });
    fs.writeFileSync(configPath, config, 'utf8');

    const err = captureThrow(() =>
      assertOpenCodeBaseUrlAllowed(configPath, { GLM_BASE_URL: 'https://api.competitor.example/anthropic' }),
      '${VAR} → foreign host must be refused',
    ) as { code?: string; reason?: string };
    assert.equal(err.code, 'OPENCODE_BASEURL_NOT_ALLOWED');
    assert.equal(err.reason, 'disallowed_host');
  });

  it('a {env:…} template whose var is UNSET is refused (un-vettable → fail-closed)', () => {
    const configPath = path.join(tempDir, 'opencode', OPENCODE_CONFIG_FILENAME);
    const config = JSON.stringify({
      provider: { glm: { options: { baseURL: '{env:GLM_BASE_URL}' } } },
    });
    fs.writeFileSync(configPath, config, 'utf8');

    const err = captureThrow(() =>
      // empty env → var is unset → residual template → fail-closed
      assertOpenCodeBaseUrlAllowed(configPath, {}),
      '{env:…} with unset var must be refused',
    ) as { code?: string };
    assert.equal(err.code, 'OPENCODE_BASEURL_NOT_ALLOWED');
  });

  it('the single approved carrier host derives from the same constant as the canonical config', () => {
    // GLM_CARRIER_BASE_URL (from config-material.js) and ALLOWED_CARRIER_HOST (from
    // opencode-baseurl-guard.js) must agree — they share one source of truth.
    assert.equal(ALLOWED_CARRIER_HOST, 'api.z.ai', 'approved carrier host');
    assert.ok(GLM_CARRIER_BASE_URL.includes('api.z.ai'), 'GLM_CARRIER_BASE_URL must match');
  });
});

// ---------------------------------------------------------------------------
// 3. Config-fingerprint drift detection (GL-2 regression, "رفض المنجرف بالبصمة")
// ---------------------------------------------------------------------------

describe('GL-10 — opencode.json fingerprint drift detection (GL-2 regression)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-config-drift-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('the canonical config matches its own fingerprint (authentic = true)', () => {
    const configDir = path.join(tempDir, 'opencode');
    const configPath = path.join(configDir, OPENCODE_CONFIG_FILENAME);
    fs.mkdirSync(configDir, { recursive: true });
    // Write the EXACT canonical bytes (same as materializeOpenCodeConfig writes).
    fs.writeFileSync(configPath, serializeOpenCodeConfig(), 'utf8');

    assert.equal(openCodeConfigMatches(configPath), true, 'authentic canonical config must match');
  });

  it('a tampered opencode.json is detected (drift = false)', () => {
    const configDir = path.join(tempDir, 'opencode');
    const configPath = path.join(configDir, OPENCODE_CONFIG_FILENAME);
    fs.mkdirSync(configDir, { recursive: true });
    // Tampered: inject a different baseURL (the drift the gate must detect).
    fs.writeFileSync(configPath, JSON.stringify({
      provider: { glm: { options: { baseURL: 'https://api.attacker.example/anthropic' } } },
    }), 'utf8');

    assert.equal(openCodeConfigMatches(configPath), false, 'tampered config must NOT match');
  });

  it('a symlinked opencode.json is rejected as un-governed (never accept a link)', () => {
    const configDir = path.join(tempDir, 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    const realFile = path.join(tempDir, 'real-opencode.json');
    // Write the REAL canonical content — but as a symlink target.
    fs.writeFileSync(realFile, serializeOpenCodeConfig(), 'utf8');
    const configPath = path.join(configDir, OPENCODE_CONFIG_FILENAME);
    fs.symlinkSync(realFile, configPath);

    // lstatSync sees a symlink → NOT a file → fingerprint returns false.
    assert.equal(openCodeConfigMatches(configPath), false,
      'symlink must not be accepted as a governed copy');
  });

  it('materializeOpenCodeConfig restores a drifted file to the canonical content', () => {
    const configDir = path.join(tempDir, 'opencode');
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, OPENCODE_CONFIG_FILENAME);
    // Seed a tampered file.
    fs.writeFileSync(configPath, '{}', { mode: 0o644 });
    assert.equal(openCodeConfigMatches(configPath), false, 'pre: drifted');

    // materializeOpenCodeConfig rewrites it.
    const ok = materializeOpenCodeConfig(configDir);
    assert.equal(ok, true, 'materialize must return true on success');
    assert.equal(openCodeConfigMatches(configPath), true, 'post: restored to canonical');

    // File must be read-only 0444 after materialization.
    const mode = fs.lstatSync(configPath).mode & 0o777;
    assert.equal(mode, 0o444, 'materialized config must be read-only 0444');
  });
});

// ---------------------------------------------------------------------------
// 4. GLM key isolation in auth.json (GL-1)
// ---------------------------------------------------------------------------

describe('GL-10 — GLM key isolation in auth.json (GL-1)', () => {
  const writer = new OpenCodeCredentialsWriter();
  // auth.json lives at XDG_DATA_HOME/opencode/auth.json (userId=null → operator path).
  const authPath = path.join(sandboxData, 'opencode', 'auth.json');

  beforeEach(() => {
    // Clear the sandbox data dir between tests.
    fs.rmSync(path.join(sandboxData, 'opencode'), { recursive: true, force: true });
  });

  function readAuth(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(authPath, 'utf8'));
  }

  it('writes the GLM key as {type:"api",key} under the "glm" provider id in auth.json', async () => {
    const result = await writer.setApiKey(null, SAMPLE_GLM_KEY, 'glm');
    assert.deepEqual(result, { provider: 'opencode', configured: true });

    const auth = readAuth();
    assert.deepEqual(auth.glm, { type: 'api', key: SAMPLE_GLM_KEY },
      'glm entry must have the native opencode auth shape');
    // The glm provider id MUST NOT collide with the built-in "anthropic" provider (OCC-2).
    assert.equal('anthropic' in auth, false, 'glm write must not create an anthropic entry');
    assert.equal(await writer.isConfigured(null, 'glm'), true);
    // 0600 owner-only (not world-readable).
    assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
  });

  it('GLM key merges without disturbing a pre-existing anthropic entry', async () => {
    // Seed a pre-existing anthropic entry.
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({
      anthropic: { type: 'api', key: SAMPLE_ANTHROPIC_KEY },
      openrouter: { type: 'api', key: 'or-key' },
    }));

    await writer.setApiKey(null, SAMPLE_GLM_KEY, 'glm');
    const auth = readAuth();

    assert.deepEqual(auth.glm, { type: 'api', key: SAMPLE_GLM_KEY }, 'glm entry added');
    // Pre-existing targets are byte-for-byte intact — no contamination.
    assert.deepEqual(auth.anthropic, { type: 'api', key: SAMPLE_ANTHROPIC_KEY },
      'anthropic entry must be preserved byte-for-byte');
    assert.deepEqual(auth.openrouter, { type: 'api', key: 'or-key' });
  });

  it('deleting the GLM key removes only glm, leaving anthropic and openrouter intact', async () => {
    await writer.setApiKey(null, SAMPLE_ANTHROPIC_KEY, 'anthropic');
    await writer.setApiKey(null, SAMPLE_GLM_KEY, 'glm');

    const deleteResult = await writer.deleteApiKey(null, 'glm');
    assert.deepEqual(deleteResult, { provider: 'opencode', configured: false });

    const auth = readAuth();
    assert.equal('glm' in auth, false, 'glm entry must be removed');
    assert.deepEqual(auth.anthropic, { type: 'api', key: SAMPLE_ANTHROPIC_KEY },
      'anthropic must survive glm deletion');
    // Idempotent: a second delete is safe.
    await writer.deleteApiKey(null, 'glm');
    assert.equal(await writer.isConfigured(null, 'glm'), false);
  });
});

// ---------------------------------------------------------------------------
// 5. Cage mask: GLM key covered by the opencode entry (SL-6)
// ---------------------------------------------------------------------------

describe('GL-10 — cage mask covers the GLM key (SL-6)', () => {
  it('CAGE_SHARED_CREDENTIALS.opencode includes the auth.json relative path', () => {
    // The GLM key lives as a JSON entry INSIDE opencode's auth.json (GL-1).
    // Masking auth.json in another provider's cage therefore masks the GLM key too
    // (documented in provider-cage-wiring.js comment for the glm entry).
    const opencodeMasks = CAGE_SHARED_CREDENTIALS.opencode;
    assert.ok(Array.isArray(opencodeMasks) || opencodeMasks != null,
      'opencode cage mask set must exist');
    const masks: readonly string[] = Array.isArray(opencodeMasks) ? opencodeMasks : [];
    const hasAuthJson = masks.some((rel: string) => rel.includes('auth.json'));
    assert.ok(hasAuthJson,
      `CAGE_SHARED_CREDENTIALS.opencode must include a path containing "auth.json" to cover ` +
      `the GLM key (a JSON entry inside that file). Found: ${JSON.stringify(masks)}`);
  });

  it('auth.json mask path is relative and does not include the home prefix', () => {
    // The cage mount plan prepends homedir() to every relative path in CAGE_SHARED_CREDENTIALS.
    // Verify the path is stored as a homedir-relative string (not absolute) so the
    // plan stays correct on every fleet node regardless of the operator user's home.
    const masks: readonly string[] = Array.isArray(CAGE_SHARED_CREDENTIALS.opencode)
      ? CAGE_SHARED_CREDENTIALS.opencode
      : [];
    for (const rel of masks) {
      assert.ok(!path.isAbsolute(rel),
        `cage mask path "${rel}" must be relative (prepended with homedir per fleet node)`);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Governance fail-closed (GL-5, "رفض غير المحكوم")
// ---------------------------------------------------------------------------

describe('GL-10 — governance fail-closed (GL-5)', () => {
  // Each test gets a fresh HOME so the neutral source presence/absence is controlled.
  let savedHome: string | undefined;
  let govTempHome: string;

  beforeEach(() => {
    savedHome = process.env.HOME;
    govTempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-gov-'));
    process.env.HOME = govTempHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    fs.rmSync(govTempHome, { recursive: true, force: true });
  });

  /** Seeds a valid ~/.claude/AGENTS.md in the current temp home. */
  function seedNeutralSource(content = '# nassaj governance (integration test)\n\nrules…\n'): string {
    const claudeDir = path.join(govTempHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const src = path.join(claudeDir, OPENCODE_AGENTS_FILENAME);
    fs.writeFileSync(src, content, 'utf8');
    return src;
  }

  it('THROWS VendorGovernanceMissingError when no neutral source exists (carrier is refused)', () => {
    // No ~/.claude/AGENTS.md — the carrier must not spawn.
    let caught: unknown;
    try {
      ensureOpenCodeGovernance(null);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof VendorGovernanceMissingError,
      'must throw the typed governance error');
    assert.equal((caught as InstanceType<typeof VendorGovernanceMissingError>).code, GOVERNANCE_MISSING_CODE);
    assert.equal((caught as InstanceType<typeof VendorGovernanceMissingError>).vendorId, 'opencode');
  });

  it('SUCCEEDS and materializes a read-only 0444 COPY when the neutral source exists', () => {
    seedNeutralSource();
    const result = ensureOpenCodeGovernance(null);
    assert.equal(result.ok, true);

    // The materialized copy is a REAL FILE (not a symlink) at the opencode config-home.
    const copyPath = path.join(govTempHome, '.config', 'opencode', OPENCODE_AGENTS_FILENAME);
    const st = fs.lstatSync(copyPath);
    assert.ok(st.isFile(), 'governance must be a real file');
    assert.ok(!st.isSymbolicLink(), 'governance must be a COPY — never a symlink');
    assert.equal(st.mode & 0o777, 0o444, 'governance copy must be read-only 0444');
  });

  it('is idempotent: a second call is a no-op fast path when governance is already authentic', () => {
    seedNeutralSource();
    ensureOpenCodeGovernance(null); // first: materializes
    // Second call must not throw and must see the same authentic result.
    const result2 = ensureOpenCodeGovernance(null);
    assert.equal(result2.ok, true);
  });
});

// ---------------------------------------------------------------------------
// 7. Binary digest deviation (SL-7/GL-6, "رفض انحراف digest")
// ---------------------------------------------------------------------------

describe('GL-10 — binary digest deviation (SL-7/GL-6)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glm-digest-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('throws VendorBinaryIntegrityError when the binary has wrong bytes (enforced:true)', () => {
    const fakeBinary = path.join(tempDir, 'opencode-wrong');
    // Write random bytes — sha256 will NOT match the pinned digest.
    fs.writeFileSync(fakeBinary, Buffer.from('this is not the vetted opencode binary'));

    let caught: unknown;
    try {
      verifyVendorBinaryDigest('opencode', fakeBinary, { enforced: true });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof VendorBinaryIntegrityError,
      'must throw the typed binary integrity error');
    const integrityErr = caught as InstanceType<typeof VendorBinaryIntegrityError>;
    assert.equal(integrityErr.vendorId, 'opencode');
    assert.equal(integrityErr.reason, 'mismatch');
    assert.equal(integrityErr.expected, PINNED_VENDOR_DIGESTS.opencode.sha256);
  });

  it('throws with reason "unverifiable" when the path does not exist (fail-closed)', () => {
    const missingPath = path.join(tempDir, 'opencode-does-not-exist');
    // The binary does not exist → cannot be hashed → treated as tampered.
    let caught: unknown;
    try {
      verifyVendorBinaryDigest('opencode', missingPath, { enforced: true });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof VendorBinaryIntegrityError,
      'missing binary must throw VendorBinaryIntegrityError');
    assert.equal((caught as InstanceType<typeof VendorBinaryIntegrityError>).reason, 'unverifiable');
  });

  it('is a no-op when the guard is disabled (enforced:false) regardless of content', () => {
    const fakeBinary = path.join(tempDir, 'opencode-junk');
    fs.writeFileSync(fakeBinary, 'completely wrong');
    // enforced:false → guard is a strict no-op; returns the path unchanged.
    const result = verifyVendorBinaryDigest('opencode', fakeBinary, { enforced: false });
    assert.equal(result, fakeBinary, 'disabled guard must return the path unchanged');
  });

  it('the pinned opencode digest is present and has the expected version and artifact', () => {
    // Confirm the pin table entry looks well-formed (a guard against accidental
    // zero-value initialization that would make the guard a no-op).
    const pin = PINNED_VENDOR_DIGESTS.opencode;
    assert.ok(pin, 'opencode pin entry must exist');
    assert.equal(pin.version, '1.17.18', 'pinned opencode version');
    assert.equal(pin.artifact, 'opencode', 'pinned opencode artifact name');
    assert.match(pin.sha256, /^[0-9a-f]{64}$/, 'sha256 must be a 64-char hex string');
  });
});

// ---------------------------------------------------------------------------
// 8. Localhost server confinement (GL-6, "حصر localhost")
// ---------------------------------------------------------------------------

describe('GL-10 — localhost server confinement (GL-6)', () => {
  // The canonical args a carrier spawn would send.
  const CANONICAL_CARRIER_ARGS = ['run', '--format', 'json', 'do the task'];

  it('the canonical carrier run args pass the server-local guard without throwing', () => {
    assert.doesNotThrow(() => assertOpenCodeCarrierServerLocal(CANONICAL_CARRIER_ARGS));
  });

  it('REFUSES the `serve` subcommand (long-lived server, not a one-shot run)', () => {
    const err = captureThrow(
      () => assertOpenCodeCarrierServerLocal(['serve', '--port', '4096']),
      'serve must be refused',
    ) as { code?: string; reason?: string };
    assert.equal(err.code, 'OPENCODE_BASEURL_NOT_ALLOWED');
    assert.equal(err.reason, 'server_exposed');
  });

  it('REFUSES a non-loopback --hostname binding (space-form)', () => {
    const err = captureThrow(
      () => assertOpenCodeCarrierServerLocal(['run', '--hostname', '0.0.0.0']),
      '--hostname 0.0.0.0 must be refused',
    ) as { reason?: string };
    assert.equal(err.reason, 'server_exposed');
  });

  it('REFUSES a non-loopback --hostname binding (=form)', () => {
    const err = captureThrow(
      () => assertOpenCodeCarrierServerLocal(['run', '--hostname=192.168.1.1']),
      '--hostname=<public-ip> must be refused',
    ) as { reason?: string };
    assert.equal(err.reason, 'server_exposed');
  });

  it('ALLOWS an explicit loopback --hostname (127.0.0.1, ::1, localhost)', () => {
    for (const bind of [
      ['run', '--hostname', '127.0.0.1'],
      ['run', '--hostname', 'localhost'],
      ['run', '--host=::1'],
    ]) {
      assert.doesNotThrow(() => assertOpenCodeCarrierServerLocal(bind),
        `loopback bind ${JSON.stringify(bind)} must be allowed`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. Carrier flag OFF identity (NASSAJ_OPENCODE_CARRIER)
// ---------------------------------------------------------------------------

describe('GL-10 — carrier flag OFF identity (NASSAJ_OPENCODE_CARRIER)', () => {
  // NOTE (B-232): the carrier-enable BEHAVIOUR (flag absent ⇒ OFF even for a
  // glm/* turn / over options.carrier; flag present ⇒ ON for a glm/* turn; flag
  // alone ⇒ OFF for a non-GLM turn) is asserted against the launcher's decision
  // seam in server/opencode-carrier-model-detection.test.ts. It lives there, in
  // the server root, because isOpenCodeCarrierRun is a root module: importing it
  // from inside server/modules/** trips the boundaries/no-unknown architectural
  // rule. What stays HERE is only what the integration layer can assert without
  // crossing that boundary (the rename-drift guard below reads the launcher as
  // TEXT, no import).

  it('a missing opencode.json is a safe no-op (not a refusal) when the carrier is inactive', () => {
    // When the carrier is OFF, the launcher never calls assertOpenCodeBaseUrlAllowed.
    // Independently: the guard's ABSENT-FILE posture is a no-op, so an operator
    // who does not have a carrier opencode.json is never accidentally blocked.
    const env = { XDG_CONFIG_HOME: path.join(sandboxHome, '.config-nonexistent') };
    const configPath = resolveOpenCodeConfigPath(env as NodeJS.ProcessEnv);
    // The file does not exist → assertOpenCodeBaseUrlAllowed is a no-op (not a throw).
    assert.doesNotThrow(() => assertOpenCodeBaseUrlAllowed(configPath, {}),
      'absent opencode.json must be a guard no-op, not a refusal');
  });

  it('the carrier flag constant name is NASSAJ_OPENCODE_CARRIER (rename-drift guard)', () => {
    // Statically verify the launcher file contains the canonical flag constant.
    // If the name ever drifts in opencode-cli.js, this test catches it so the flag
    // docs/env-seeding remain consistent.
    const launcherSrc = fs.readFileSync(
      path.join(REPO_ROOT, 'server', 'opencode-cli.js'),
      'utf8',
    );
    assert.ok(launcherSrc.includes('NASSAJ_OPENCODE_CARRIER'),
      'opencode-cli.js must reference the canonical NASSAJ_OPENCODE_CARRIER flag constant');
  });

  it('the canonical opencode.json content encodes only the vetted GLM carrier host', () => {
    // An additional safety check: the materialized config can never encode a host
    // other than the one the GL-3 guard approves — single source of truth.
    const config = buildOpenCodeConfig();
    const baseURL = config.provider?.glm?.options?.baseURL;
    assert.equal(typeof baseURL, 'string', 'canonical config must have a glm.options.baseURL');
    assert.equal(baseURL, GLM_CARRIER_BASE_URL,
      'canonical config baseURL must equal the GLM_CARRIER_BASE_URL constant');
    assert.ok(typeof baseURL === 'string' && baseURL.includes('api.z.ai'),
      'canonical config baseURL must point at the approved z.ai host');
  });
});
