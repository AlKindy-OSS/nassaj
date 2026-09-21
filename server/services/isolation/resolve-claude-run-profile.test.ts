import assert from 'node:assert/strict';
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
  delete process.env.NASSAJ_ENGINE_PIN_ENFORCE;
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
