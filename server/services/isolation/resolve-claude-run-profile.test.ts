// B-1771: FIRST import. Run ad hoc with the operator HOME, this test wrote into
// the real home (member tree or provider state); the sandbox moves HOME first.
import '@/shared/__tests__/sandbox-home.js';

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
  credentialGateCalls: Array<{ actor: unknown; engine: string | null }>;
  credentialGateError: Error | null;
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
  credentialGateCalls: [],
  credentialGateError: null,
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
mock.module('@/services/isolation/credential-gate.js', {
  namedExports: {
    assertCredentialLinked: (input: { actor: unknown; engine: string | null }) => {
      state.credentialGateCalls.push({ actor: input.actor, engine: input.engine });
      if (state.credentialGateError) throw state.credentialGateError;
      return { principalId: input.actor, grantedBy: null, unit: input.engine ?? 'claude', ownOnly: Boolean(input.engine) };
    },
  },
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
  state.credentialGateCalls = [];
  state.credentialGateError = null;
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

test('B-1764: a base URL planted in the project settings refuses the profile, official and pinned', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-profile-b1764-'));
  const project = path.join(root, 'project');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(project, '.claude', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434' } }));
  try {
    for (const clientEngine of [undefined, 'glm']) {
      await assert.rejects(
        profileModule.resolveClaudeRunProfileOrThrow({
          userId: 7,
          clientEngine,
          baseEnv: { CLAUDE_CONFIG_DIR: path.join(root, '.claude'), HOME: root },
          envAlreadyIsolated: true,
          cwd: project,
        }),
        (err: { code?: string }) => err.code === 'ANTHROPIC_BASE_URL_NOT_ALLOWED',
        `engine ${clientEngine ?? 'official'}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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

test('ADR-152 A1 §3.5: the credential gate admits on the resolved engine, before the engine env', async () => {
  const { root, configDir } = userTreeWithKey();
  try {
    const profile = await profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      clientEngine: 'glm',
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      cwd: path.join(root, 'project'),
    });
    assert.deepEqual(state.credentialGateCalls, [{ actor: 7, engine: 'glm' }]);
    assert.deepEqual(profile.credential, { principalId: 7, grantedBy: null, unit: 'glm', ownOnly: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ADR-152 A1 §3.5: a credential refusal stops the run before any engine env is applied', async () => {
  const { root, configDir } = userTreeWithKey();
  state.credentialGateError = Object.assign(new Error('not linked'), { code: 'CREDENTIAL_NOT_LINKED' });
  try {
    await assert.rejects(profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      clientEngine: 'glm',
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      cwd: path.join(root, 'project'),
    }), (error: Error & { code?: string }) => error.code === 'CREDENTIAL_NOT_LINKED');
    assert.equal(state.appliedEngine, undefined, 'no engine env was applied');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ADR-152 A1 §3.5: a PTY terminal launch (honorGrants:false) is not gated — linking happens there', async () => {
  const { root, configDir } = userTreeWithKey();
  state.credentialGateError = new Error('must not be reached');
  try {
    await profileModule.resolveClaudeRunProfileOrThrow({
      userId: 7,
      baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
      envAlreadyIsolated: true,
      honorGrants: false,
      cwd: path.join(root, 'project'),
    });
    assert.deepEqual(state.credentialGateCalls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── ADR-227 / T-2098 stage 3a: the local-engine path ─────────────────────────

const LOCAL_SERVER = {
  id: '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11',
  ownerId: 7,
  providerId: 'nassaj_local_0b9c6a3e6f1e4c419a4e2f1b9e0c7d11',
  baseUrl: 'http://127.0.0.1:18080/v1',
  verifiedAddresses: ['127.0.0.1'],
  models: [{ id: 'gpt-oss-20b', contextWindow: 32768 }],
};
const LOCAL_MODEL = `${LOCAL_SERVER.providerId}/gpt-oss-20b`;
const localDeps = {
  enabled: () => true,
  runnable: () => true,
  listServers: (userId: unknown) => (Number(userId) === 7 ? [LOCAL_SERVER] : []),
  getSecret: () => null,
  resolvePrivate: async () => ({ address: '127.0.0.1', family: 4 }),
  cliVersionProven: async () => true,
};
const { formatLocalEnginePin } = await import('./local-engine-pin.js');
const LOCAL_PIN = formatLocalEnginePin({ serverId: LOCAL_SERVER.id, ownerId: 7, origin: 'http://127.0.0.1:18080' });

function localProfile(input: Record<string, unknown>) {
  const { configDir, root } = userTreeWithKey();
  return profileModule.resolveClaudeRunProfileOrThrow({
    userId: 7,
    baseEnv: { CLAUDE_CONFIG_DIR: configDir, HOME: root },
    envAlreadyIsolated: true,
    cwd: path.join(root, 'project'),
    localEngineDeps: localDeps,
    ...input,
  });
}

const localRefusal = (reason: string) => (error: Error & { code?: string; reason?: string }) =>
  error.code === 'ENGINE_PROVIDER_UNAVAILABLE' && error.reason === reason;

test('ADR-227: a new session naming a local model runs local, on its own derived dir, without the link gate', async () => {
  const profile = await localProfile({ requestedModel: LOCAL_MODEL });
  assert.equal(profile.effectiveEngine, LOCAL_PIN);
  assert.equal(profile.engineHosts?.size, 0);
  assert.deepEqual([...(profile.engineOrigins ?? [])], ['http://127.0.0.1:18080']);
  assert.match(profile.env.CLAUDE_CONFIG_DIR ?? '', /\.claude-engine-local-0b9c6a3e6f1e4c419a4e2f1b9e0c7d11$/u);
  assert.equal(state.appliedEngine, undefined, 'the vendor-engine seam is never consulted');
  assert.deepEqual(state.gateCalls, [], 'no Anthropic link-mode gate for a local run');
  assert.deepEqual(state.credentialGateCalls, [{ actor: 7, engine: 'local' }]);
});

test('ADR-227: a local pin wins over the client and over shadow mode', async () => {
  state.pin = LOCAL_PIN;
  process.env.NASSAJ_ENGINE_PIN_ENFORCE = '0';
  for (const clientEngine of [null, 'glm']) {
    const profile = await localProfile({ sessionId: 'local-s', clientEngine, requireKnownResumePin: true });
    assert.equal(profile.effectiveEngine, LOCAL_PIN);
    assert.equal(profile.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:18080');
  }
  await assert.rejects(localProfile({ sessionId: 'local-s', requestedModel: 'claude-opus-5' }), localRefusal('pin_conflict'));
});

test('ADR-227: a local model on an existing non-local session, or with a vendor engine, is refused', async () => {
  for (const stored of [null, 'anthropic', 'glm']) {
    state.pin = stored;
    await assert.rejects(localProfile({ sessionId: 'old', requestedModel: LOCAL_MODEL }), localRefusal('pin_conflict'));
  }
  state.pin = null;
  await assert.rejects(localProfile({ requestedModel: LOCAL_MODEL, clientEngine: 'glm' }), localRefusal('pin_conflict'));
  assert.deepEqual(state.storedPins, [], 'local is never inferred or written by the profile');
});

test('ADR-227: a NULL-pin resume keeps its existing inference path, untouched by local', async () => {
  state.history = [{ agent_kind: 'model', agent_model: 'glm-model', agent_name: 'glm-model' }];
  state.catalogs = { glm: ['glm-model'], kimi: ['kimi-model'], deepseek: ['deepseek-model'] };
  const profile = await localProfile({ sessionId: 'legacy-null', authoritativeStoredPin: true, requireKnownResumePin: true });
  assert.equal(profile.effectiveEngine, 'glm');
  assert.equal(profile.local, null);
  assert.equal(profile.engineOrigins, null);
});
