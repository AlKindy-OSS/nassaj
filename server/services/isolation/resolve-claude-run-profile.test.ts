import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { beforeEach, mock } from 'node:test';

type State = {
  pin: string | null;
  pinReadError: Error | null;
  history: Array<{ agent_kind: string; agent_model: string | null; agent_name: string }>;
  catalogs: Record<string, string[]>;
  catalogFailures: Set<string>;
  degradedCatalogs: Set<string>;
  pinWriteError: Error | null;
  storedPins: Array<{ sessionId: string; engine: string; source: string }>;
  appliedEngine: string | null | undefined;
  gateCalls: Array<{ userId: unknown; provider: string; options: unknown }>;
  gateError: Error | null;
};

const state: State = {
  pin: null,
  pinReadError: null,
  history: [],
  catalogs: {},
  catalogFailures: new Set(),
  degradedCatalogs: new Set(),
  pinWriteError: null,
  storedPins: [],
  appliedEngine: undefined,
  gateCalls: [],
  gateError: null,
};

mock.module('@/modules/database/index.js', {
  namedExports: {
    auditLogDb: { record: () => undefined },
    sessionAgentsDb: { listBySession: () => state.history },
    sessionsDb: {
      getSessionEnginePin: () => {
        if (state.pinReadError) throw state.pinReadError;
        return state.pin === null ? null : { engine: state.pin };
      },
      setSessionEnginePin: (sessionId: string, engine: string, source: string) => {
        if (state.pinWriteError) throw state.pinWriteError;
        state.storedPins.push({ sessionId, engine, source });
        return { outcome: 'written', engine };
      },
    },
  },
});

mock.module('@/modules/providers/index.js', {
  namedExports: {
    providerModelsService: {
      getProviderModels: async (engine: string) => {
        if (state.catalogFailures.has(engine)) throw new Error(`catalog ${engine} unavailable`);
        return {
          models: {
            OPTIONS: (state.catalogs[engine] ?? []).map((value) => ({ value })),
            degraded: state.degradedCatalogs.has(engine),
          },
        };
      },
    },
  },
});

mock.module('@/services/isolation/resolve-provider-env.js', {
  namedExports: { resolveProviderEnv: (_userId: unknown, _provider: string, env: NodeJS.ProcessEnv) => ({ ...env }) },
});
mock.module('@/services/isolation/resolve-provider-env-strict.js', {
  namedExports: { resolveProviderEnvStrict: (_userId: unknown, _provider: string, env: NodeJS.ProcessEnv) => ({ ...env }) },
});
mock.module('@/services/isolation/collect-settings-base-urls.js', {
  namedExports: { collectSettingsBaseUrls: async () => [] },
});
mock.module('@/services/isolation/apply-claude-engine-provider-env.js', {
  namedExports: {
    applyClaudeEngineProviderEnvOrThrow: (env: NodeJS.ProcessEnv, _userId: unknown, engine: string | null) => {
      state.appliedEngine = engine;
      if (!engine) return null;
      const host = engine === 'glm' ? 'api.z.ai' : `api.${engine}.example`;
      env.ANTHROPIC_BASE_URL = `https://${host}`;
      env.ANTHROPIC_AUTH_TOKEN = 'test-token';
      return new Set([host]);
    },
  },
});

// ADR-200 S10 (B-1575): the run gate is armed by default; its read-only leaf is
// replaced so the real flag check in link-mode-run-gate.js stays under test.
mock.module('@/modules/providers/services/harness-link-mode.scope.js', {
  namedExports: {
    assertLinkModeRunAllowed: (userId: unknown, provider: string, options: unknown) => {
      state.gateCalls.push({ userId, provider, options });
      if (state.gateError) throw state.gateError;
    },
  },
});

const profileModule = await import('./resolve-claude-run-profile.js');

beforeEach(() => {
  state.pin = null;
  state.pinReadError = null;
  state.history = [];
  state.catalogs = {};
  state.catalogFailures = new Set();
  state.degradedCatalogs = new Set();
  state.pinWriteError = null;
  state.storedPins = [];
  state.appliedEngine = undefined;
  state.gateCalls = [];
  state.gateError = null;
  delete process.env.NASSAJ_ENGINE_PIN_ENFORCE;
  delete process.env.NASSAJ_UNIFIED_VENDOR_KEYS;
});

test('stored pin wins a mismatched client engine for an authoritative resume', async () => {
  state.pin = 'glm';
  process.env.NASSAJ_ENGINE_PIN_ENFORCE = '1';
  const profile = await profileModule.resolveClaudeRunProfileOrThrow({
    userId: 7,
    sessionId: 'resume-1',
    clientEngine: 'kimi',
    baseEnv: {},
    envAlreadyIsolated: true,
    authoritativeStoredPin: true,
    requireKnownResumePin: true,
    failOnAmbiguous: true,
  });
  assert.equal(profile.effectiveEngine, 'glm');
  assert.equal(state.appliedEngine, 'glm');
  assert.equal(profile.env.ANTHROPIC_BASE_URL, 'https://api.z.ai');
});

test('explicit enforcement opt-out keeps browser mismatch in shadow mode', async () => {
  state.pin = 'glm';
  process.env.NASSAJ_ENGINE_PIN_ENFORCE = '0';
  const profile = await profileModule.resolveClaudeRunProfileOrThrow({
    userId: 7,
    sessionId: 'browser-resume-shadow',
    clientEngine: 'kimi',
    baseEnv: {},
    envAlreadyIsolated: true,
    requireKnownResumePin: true,
    failOnAmbiguous: true,
  });
  assert.equal(profile.effectiveEngine, 'kimi');
  assert.equal(state.appliedEngine, 'kimi');
});

test('resume fails closed when the stored pin read fails or no pin can be inferred', async () => {
  state.pinReadError = new Error('database offline');
  await assert.rejects(
    profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      sessionId: 'resume-db-fail',
      baseEnv: {},
      envAlreadyIsolated: true,
      requireKnownResumePin: true,
    }),
    (error: Error & { code?: string }) => error.code === 'ENGINE_PIN_READ_FAILED',
  );

  state.pinReadError = null;
  await assert.rejects(
    profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      sessionId: 'resume-unknown',
      baseEnv: {},
      envAlreadyIsolated: true,
      requireKnownResumePin: true,
    }),
    (error: Error & { code?: string }) => error.code === 'ENGINE_PIN_UNKNOWN',
  );
  assert.equal(state.appliedEngine, undefined, 'no engine env is built after either refusal');
});

test('legacy resume infers and persists one unambiguous engine, but rejects ambiguous history', async () => {
  state.history = [{ agent_kind: 'model', agent_model: 'glm-model', agent_name: 'glm-model' }];
  state.catalogs = { glm: ['glm-model'], kimi: ['kimi-model'], deepseek: ['deepseek-model'] };
  const inferred = await profileModule.resolveClaudeRunProfileOrThrow({
    userId: 7,
    sessionId: 'legacy-1',
    baseEnv: {},
    envAlreadyIsolated: true,
    authoritativeStoredPin: true,
    requireKnownResumePin: true,
    failOnAmbiguous: true,
  });
  assert.equal(inferred.effectiveEngine, 'glm');
  assert.equal(state.storedPins.length, 1);
  assert.equal(state.storedPins[0]!.engine, 'glm');

  state.history = [
    { agent_kind: 'model', agent_model: 'glm-model', agent_name: 'glm-model' },
    { agent_kind: 'model', agent_model: 'kimi-model', agent_name: 'kimi-model' },
  ];
  await assert.rejects(
    profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      sessionId: 'legacy-ambiguous',
      baseEnv: {},
      envAlreadyIsolated: true,
      requireKnownResumePin: true,
      failOnAmbiguous: true,
    }),
    (error: Error & { code?: string }) => error.code === 'ENGINE_PIN_AMBIGUOUS',
  );
});

test('resume inference rejects a partial engine-catalog universe before pinning', async () => {
  state.history = [{ agent_kind: 'model', agent_model: 'glm-model', agent_name: 'glm-model' }];
  state.catalogs = { glm: ['glm-model'], kimi: ['kimi-model'], deepseek: ['deepseek-model'] };
  state.catalogFailures.add('kimi');
  await assert.rejects(
    profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      sessionId: 'legacy-partial',
      baseEnv: {},
      envAlreadyIsolated: true,
      requireKnownResumePin: true,
      failOnAmbiguous: true,
    }),
    (error: Error & { code?: string }) => error.code === 'ENGINE_PIN_CATALOG_INCOMPLETE',
  );
  assert.equal(state.storedPins.length, 0);
});

test('resume inference treats a degraded catalog as incomplete even when it has OPTIONS', async () => {
  state.history = [{ agent_kind: 'model', agent_model: 'glm-model', agent_name: 'glm-model' }];
  state.catalogs = { glm: ['glm-model'], kimi: ['kimi-model'], deepseek: ['deepseek-model'] };
  state.degradedCatalogs.add('kimi');
  await assert.rejects(
    profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      sessionId: 'legacy-degraded',
      baseEnv: {},
      envAlreadyIsolated: true,
      requireKnownResumePin: true,
      failOnAmbiguous: true,
    }),
    (error: Error & { code?: string }) => error.code === 'ENGINE_PIN_CATALOG_INCOMPLETE',
  );
  assert.equal(state.storedPins.length, 0);
});

test('resume inference refuses a pin write failure before building engine env', async () => {
  state.history = [{ agent_kind: 'model', agent_model: 'glm-model', agent_name: 'glm-model' }];
  state.catalogs = { glm: ['glm-model'], kimi: ['kimi-model'], deepseek: ['deepseek-model'] };
  state.pinWriteError = new Error('database became read-only');
  await assert.rejects(
    profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      sessionId: 'legacy-write-fail',
      baseEnv: {},
      envAlreadyIsolated: true,
      requireKnownResumePin: true,
      failOnAmbiguous: true,
    }),
    (error: Error & { code?: string }) => error.code === 'ENGINE_PIN_WRITE_FAILED',
  );
  assert.equal(state.appliedEngine, undefined);
});

test('final host guard rejects a disallowed base URL before returning a profile', async () => {
  state.pin = 'claude';
  await assert.rejects(
    profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      sessionId: 'official-1',
      baseEnv: { OPENAI_BASE_URL: 'https://evil.example' },
      envAlreadyIsolated: true,
      authoritativeStoredPin: true,
      requireKnownResumePin: true,
      failOnAmbiguous: true,
    }),
    /disallowed host/,
  );
});

/** A user tree whose settings.json holds an API key for official turns (dummy). */
function userTreeWithKey(): { root: string; configDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-profile-s2-'));
  const configDir = path.join(root, '.claude');
  fs.mkdirSync(path.join(configDir, 'projects'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk' + '-ant-api03-DUMMY-RUN-PROFILE' } }));
  fs.writeFileSync(path.join(configDir, '.claude.json'), JSON.stringify({ primaryApiKey: 'sk' + '-ant-api03-DUMMY-2' }));
  fs.mkdirSync(path.join(root, 'project'));
  return { root, configDir };
}

test('ADR-200 S2: a pinned profile runs on the derived credential-free config dir', async () => {
  const { root, configDir } = userTreeWithKey();
  try {
    const profile = await profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      clientEngine: 'glm',
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      cwd: path.join(root, 'project'),
    });
    const derived = path.join(root, '.claude-engine-pin');
    assert.equal(profile.env.CLAUDE_CONFIG_DIR, derived);
    const settings = JSON.parse(fs.readFileSync(path.join(derived, 'settings.json'), 'utf8'));
    assert.equal(settings.env?.ANTHROPIC_API_KEY, undefined);
    const config = JSON.parse(fs.readFileSync(path.join(derived, '.claude.json'), 'utf8'));
    assert.equal(config.primaryApiKey, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ADR-200 S2: an unpinned profile keeps the user config dir untouched', async () => {
  const { root, configDir } = userTreeWithKey();
  try {
    const profile = await profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      cwd: path.join(root, 'project'),
    });
    assert.equal(profile.env.CLAUDE_CONFIG_DIR, configDir);
    assert.equal(fs.existsSync(path.join(root, '.claude-engine-pin')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ADR-200 S10: with the flag unset an official run passes the link-mode gate', async () => {
  const { root, configDir } = userTreeWithKey();
  try {
    await profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      cwd: path.join(root, 'project'),
    });
    assert.deepEqual(state.gateCalls.map(call => [call.userId, call.provider]), [[7, 'claude']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ADR-200 S10: a gate refusal stops the official run before a profile is returned', async () => {
  const { root, configDir } = userTreeWithKey();
  state.gateError = Object.assign(new Error('key missing'), { code: 'LINK_MODE_KEY_MISSING' });
  try {
    await assert.rejects(profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      cwd: path.join(root, 'project'),
    }), (error: Error & { code?: string }) => error.code === 'LINK_MODE_KEY_MISSING');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ADR-200 S10: an engine-pinned run and the kill switch both skip the gate', async () => {
  const { root, configDir } = userTreeWithKey();
  try {
    await profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      clientEngine: 'glm',
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      cwd: path.join(root, 'project'),
    });
    process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
    state.gateError = new Error('must not be reached');
    await profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      cwd: path.join(root, 'project'),
    });
    assert.equal(state.gateCalls.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
