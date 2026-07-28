import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';

// ---------------------------------------------------------------------------
// SDK mock. The catalog client probes the model list through the Agent SDK's
// `query(...).supportedModels()` control request. We replace the SDK module so
// the tests never spawn a real Claude Code child process: each test installs a
// `currentProbe` behaviour that the fake `query` consults.
//
// `mock.module` must be registered before the module-under-test is imported, so
// the import below is dynamic (after the mock is set up).
// ---------------------------------------------------------------------------

type ProbeBehaviour = {
  supportedModels: () => Promise<unknown>;
  onInterrupt?: () => void;
  onConstruct?: () => void;
};

let currentProbe: ProbeBehaviour = {
  supportedModels: async () => [],
};

mock.module('@anthropic-ai/claude-agent-sdk', {
  namedExports: {
    query: () => {
      currentProbe.onConstruct?.();
      return {
        supportedModels: () => currentProbe.supportedModels(),
        interrupt: async () => {
          currentProbe.onInterrupt?.();
        },
        // The async-iterator surface is never consumed by the catalog client
        // (it only calls supportedModels()), but provide a no-op for safety.
        [Symbol.asyncIterator]: async function* () {
          // yields nothing
        },
      };
    },
  },
});

const {
  buildClaudeModelsDefinition,
  getClaudeModelCatalog,
  __resetClaudeCatalogCircuit,
} = await import('@/modules/providers/list/claude/claude-catalog.client.js');
const { CLAUDE_FALLBACK_MODELS } = await import(
  '@/modules/providers/list/claude/claude-models.provider.js'
);
const {
  recordBrokenModel,
  __setBrokenModelsStorePathForTests,
} = await import('@/modules/providers/list/claude/claude-broken-models.store.js');

// Redirect the broken-models store to an ephemeral path so these tests never read
// or write the operator's real ~/.cloudcli store, and reset it between cases.
const ephemeralBrokenStorePath = (): string =>
  path.join(os.tmpdir(), `claude-broken-models-test-${process.pid}-${Math.random().toString(16).slice(2)}.json`);

const SAMPLE_LIVE_MODELS = [
  {
    value: 'default',
    displayName: 'Default (recommended)',
    description: 'Opus 4.7 with 1M context · Most capable for complex work',
  },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Sonnet 4.6 · Best for everyday tasks' },
  { value: 'haiku', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers' },
  { value: 'claude-opus-4-8', displayName: 'claude-opus-4-8', description: 'Custom model' },
];

// ---------------- buildClaudeModelsDefinition (pure) ----------------

test('buildClaudeModelsDefinition: maps ModelInfo[] into OPTIONS preserving order + descriptions', () => {
  const result = buildClaudeModelsDefinition(SAMPLE_LIVE_MODELS);

  assert.ok(result);
  assert.deepEqual(
    result.OPTIONS.map((o) => o.value),
    ['default', 'sonnet', 'haiku', 'claude-opus-4-8'],
  );
  const opus = result.OPTIONS.find((o) => o.value === 'claude-opus-4-8');
  assert.equal(opus?.label, 'claude-opus-4-8');
  assert.equal(opus?.description, 'Custom model');
  // The newest model the account can use is surfaced automatically.
  assert.ok(result.OPTIONS.some((o) => o.value === 'claude-opus-4-8'));
});

test('buildClaudeModelsDefinition: keeps the fallback DEFAULT when the live catalog offers it', () => {
  const result = buildClaudeModelsDefinition(SAMPLE_LIVE_MODELS);
  assert.equal(result?.DEFAULT, CLAUDE_FALLBACK_MODELS.DEFAULT);
  assert.equal(result?.DEFAULT, 'default');
});

test('buildClaudeModelsDefinition: anchors DEFAULT on first option when fallback DEFAULT is absent', () => {
  const result = buildClaudeModelsDefinition([
    { value: 'sonnet', displayName: 'Sonnet' },
    { value: 'haiku', displayName: 'Haiku' },
  ]);
  assert.equal(result?.DEFAULT, 'sonnet');
});

test('buildClaudeModelsDefinition: de-dupes by value and drops entries without a usable id', () => {
  const result = buildClaudeModelsDefinition([
    { value: 'sonnet', displayName: 'Sonnet' },
    { value: 'sonnet', displayName: 'Sonnet (dup)' },
    { displayName: 'no id' },
    { value: '   ' },
  ]);
  assert.ok(result);
  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['sonnet']);
});

test('buildClaudeModelsDefinition: returns null for empty/invalid input', () => {
  assert.equal(buildClaudeModelsDefinition(null), null);
  assert.equal(buildClaudeModelsDefinition([]), null);
  assert.equal(buildClaudeModelsDefinition([{ displayName: 'no id' }]), null);
});

// ---------------- unreleased-model handling (claude-fable-5) ----------------
//
// The hand-maintained UNRELEASED_HIDDEN_MODELS hide-list was REMOVED. Unreleased
// models are now kept out of the picker by two real mechanisms instead:
//   1. The live probe runs under the user's REAL credentials (resolveProviderEnv),
//      so Anthropic's own entitlement filtering never advertises claude-fable-5
//      for an account that cannot use it — the builder simply never sees it.
//   2. The lazy-detection `excluded` set drops any model proved broken at real
//      use, even if the authenticated catalog still advertises it.
// So the builder itself no longer special-cases fable; it surfaces exactly what
// it is given, minus the `excluded` set. These tests pin that new contract.

test('buildClaudeModelsDefinition: surfaces every advertised model in order (no hand hide-list)', () => {
  // Under real authentication the SDK list already excludes unreleased models, so
  // a representative authenticated list maps through untouched and in order.
  const result = buildClaudeModelsDefinition(SAMPLE_LIVE_MODELS);

  assert.ok(result);
  assert.deepEqual(
    result.OPTIONS.map((o) => o.value),
    ['default', 'sonnet', 'haiku', 'claude-opus-4-8'],
  );
  assert.equal(result.DEFAULT, 'default');
  assert.ok(
    result.OPTIONS.some((o) => o.value === result.DEFAULT),
    'DEFAULT must be one of the surviving options',
  );
});

test('buildClaudeModelsDefinition: the excluded set (lazy detection) drops a broken model while keeping the rest', () => {
  // Simulate an authenticated catalog that still advertises a model the account
  // proved broken at real use: the per-user `excluded` set removes it.
  const result = buildClaudeModelsDefinition(
    [
      {
        value: 'claude-fable-5',
        displayName: 'Fable 5',
        description: 'Fable 5 · Most powerful, most intelligent model',
      },
      ...SAMPLE_LIVE_MODELS,
    ],
    new Set(['claude-fable-5']),
  );

  assert.ok(result);
  assert.equal(
    result.OPTIONS.some((o) => o.value === 'claude-fable-5'),
    false,
    'a model in the excluded set must be dropped from the catalog',
  );
  assert.deepEqual(
    result.OPTIONS.map((o) => o.value),
    ['default', 'sonnet', 'haiku', 'claude-opus-4-8'],
  );
  assert.equal(result.DEFAULT, 'default');
});

test('buildClaudeModelsDefinition: anchors DEFAULT on the first option SURVIVING the excluded set', () => {
  // No `default` entry, and the first advertised model is excluded by lazy
  // detection: DEFAULT must fall through to the first surviving option.
  const result = buildClaudeModelsDefinition(
    [
      { value: 'claude-fable-5', displayName: 'Fable 5' },
      { value: 'sonnet', displayName: 'Sonnet' },
      { value: 'haiku', displayName: 'Haiku' },
    ],
    new Set(['claude-fable-5']),
  );

  assert.ok(result);
  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['sonnet', 'haiku']);
  assert.equal(result.DEFAULT, 'sonnet', 'DEFAULT must be the first surviving option');
  assert.notEqual(result.DEFAULT, 'claude-fable-5');
});

test('CLAUDE_FALLBACK_MODELS: does not contain the unreleased claude-fable-5 and keeps a valid DEFAULT', () => {
  assert.equal(
    CLAUDE_FALLBACK_MODELS.OPTIONS.some((o) => o.value === 'claude-fable-5'),
    false,
    'the degraded fallback catalog must not advertise the unreleased fable-5',
  );
  // DEFAULT must still resolve to a real option in the trimmed list.
  assert.equal(CLAUDE_FALLBACK_MODELS.DEFAULT, 'default');
  assert.ok(
    CLAUDE_FALLBACK_MODELS.OPTIONS.some((o) => o.value === CLAUDE_FALLBACK_MODELS.DEFAULT),
    'fallback DEFAULT must be present in fallback OPTIONS',
  );
});

// ---------------- getClaudeModelCatalog (integration, SDK mocked) ----------------

test('getClaudeModelCatalog: returns the live catalog (not degraded) on a successful probe', async () => {
  __resetClaudeCatalogCircuit();
  currentProbe = { supportedModels: async () => SAMPLE_LIVE_MODELS };

  const result = await getClaudeModelCatalog();
  assert.ok(result.OPTIONS.some((o) => o.value === 'claude-opus-4-8'));
  assert.notEqual(result.degraded, true);

  __resetClaudeCatalogCircuit();
});

test('getClaudeModelCatalog: falls back to the degraded catalog when the probe throws', async () => {
  __resetClaudeCatalogCircuit();
  currentProbe = {
    supportedModels: async () => {
      throw new Error('claude not installed');
    },
  };

  const result = await getClaudeModelCatalog();
  assert.deepEqual(result, { ...CLAUDE_FALLBACK_MODELS, degraded: true });

  __resetClaudeCatalogCircuit();
});

test('getClaudeModelCatalog: falls back when the probe returns an unusable (empty) list', async () => {
  __resetClaudeCatalogCircuit();
  currentProbe = { supportedModels: async () => [] };

  const result = await getClaudeModelCatalog();
  assert.deepEqual(result, { ...CLAUDE_FALLBACK_MODELS, degraded: true });

  __resetClaudeCatalogCircuit();
});

test('getClaudeModelCatalog: opens the circuit breaker after repeated failures', async () => {
  __resetClaudeCatalogCircuit();
  let constructCalls = 0;
  currentProbe = {
    onConstruct: () => {
      constructCalls += 1;
    },
    supportedModels: async () => {
      throw new Error('spawn failed');
    },
  };

  // Threshold is 3 consecutive failures; the 4th call must be short-circuited by
  // the open breaker and must NOT spawn another probe.
  for (let i = 0; i < 3; i += 1) {
    const result = await getClaudeModelCatalog();
    assert.deepEqual(result, { ...CLAUDE_FALLBACK_MODELS, degraded: true });
  }
  assert.equal(constructCalls, 3);

  const afterOpen = await getClaudeModelCatalog();
  assert.deepEqual(afterOpen, { ...CLAUDE_FALLBACK_MODELS, degraded: true });
  assert.equal(constructCalls, 3, 'breaker open: no further probe was spawned');

  __resetClaudeCatalogCircuit();
});

test('getClaudeModelCatalog: single-flight — concurrent callers share one probe', async () => {
  __resetClaudeCatalogCircuit();
  let constructCalls = 0;
  // Held in an object so control-flow analysis cannot narrow the field to `never`
  // after the Promise executor assigns it asynchronously.
  const probeGate: { release: () => void } = { release: () => {} };
  const gate = new Promise<void>((resolve) => {
    probeGate.release = resolve;
  });
  currentProbe = {
    onConstruct: () => {
      constructCalls += 1;
    },
    supportedModels: async () => {
      await gate;
      return SAMPLE_LIVE_MODELS;
    },
  };

  // Fire three concurrent calls before the in-flight probe resolves.
  const p1 = getClaudeModelCatalog();
  const p2 = getClaudeModelCatalog();
  const p3 = getClaudeModelCatalog();

  probeGate.release();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assert.equal(constructCalls, 1, 'only one probe should be spawned for concurrent callers');
  assert.ok(r1.OPTIONS.some((o) => o.value === 'claude-opus-4-8'));
  // All callers receive the same single-flight result.
  assert.deepEqual(r1, r2);
  assert.deepEqual(r2, r3);

  __resetClaudeCatalogCircuit();
});

// ---------------- vendor-resilience iron rule (fail-closed) ----------------
//
// The catalog probe forwards the host env into the Claude subprocess. A
// competitor ANTHROPIC_BASE_URL in the operator OS env must NEVER be allowed to
// route that subprocess to a non-Anthropic endpoint. The probe must REFUSE to
// spawn (the guard throws BEFORE query() is constructed) and degrade to the
// fallback catalog, and must be a NO-OP when no routing var is set.

test('getClaudeModelCatalog: REFUSES to spawn the probe when ANTHROPIC_BASE_URL is a disallowed host', async () => {
  __resetClaudeCatalogCircuit();
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'https://api.openai.com';

  let constructCalls = 0;
  currentProbe = {
    onConstruct: () => {
      constructCalls += 1;
    },
    // Must never be reached: the guard throws before query() is constructed.
    supportedModels: async () => SAMPLE_LIVE_MODELS,
  };

  try {
    const result = await getClaudeModelCatalog();
    // Fail-closed: the disallowed host degrades to the fallback catalog and the
    // subprocess is never spawned — Claude traffic is NEVER routed to a
    // non-Anthropic endpoint.
    assert.deepEqual(result, { ...CLAUDE_FALLBACK_MODELS, degraded: true });
    assert.equal(
      constructCalls,
      0,
      'guard must throw before query() — the Claude subprocess must NOT be spawned',
    );
  } finally {
    if (previous === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = previous;
    }
    __resetClaudeCatalogCircuit();
  }
});

test('getClaudeModelCatalog: guard is a no-op when ANTHROPIC_BASE_URL is unset (default Anthropic path)', async () => {
  __resetClaudeCatalogCircuit();
  const previous = process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_BASE_URL;

  let constructCalls = 0;
  currentProbe = {
    onConstruct: () => {
      constructCalls += 1;
    },
    supportedModels: async () => SAMPLE_LIVE_MODELS,
  };

  try {
    const result = await getClaudeModelCatalog();
    // Unset routing var → guard no-op → probe spawns and returns the live catalog.
    assert.equal(constructCalls, 1, 'unset routing var: the probe spawns normally');
    assert.ok(result.OPTIONS.some((o) => o.value === 'claude-opus-4-8'));
    assert.notEqual(result.degraded, true);
  } finally {
    if (previous === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = previous;
    }
    __resetClaudeCatalogCircuit();
  }
});

test('getClaudeModelCatalog: guard allows an official Anthropic ANTHROPIC_BASE_URL (probe spawns)', async () => {
  __resetClaudeCatalogCircuit();
  const previous = process.env.ANTHROPIC_BASE_URL;
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

  let constructCalls = 0;
  currentProbe = {
    onConstruct: () => {
      constructCalls += 1;
    },
    supportedModels: async () => SAMPLE_LIVE_MODELS,
  };

  try {
    const result = await getClaudeModelCatalog();
    assert.equal(constructCalls, 1, 'official Anthropic host is allowed: the probe spawns');
    assert.ok(result.OPTIONS.some((o) => o.value === 'claude-opus-4-8'));
    assert.notEqual(result.degraded, true);
  } finally {
    if (previous === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = previous;
    }
    __resetClaudeCatalogCircuit();
  }
});

// ---------------- real-authentication catalog (fable drops at the source) ----------------
//
// With the authenticated probe, Anthropic's own entitlement filtering returns a
// model list that already EXCLUDES unreleased models. The catalog client surfaces
// that list as-is (no hand hide-list), so claude-fable-5 is absent — proving the
// hide-list removal is covered by real authentication, not lost.

test('getClaudeModelCatalog: an authenticated list (fable already filtered by Anthropic) yields a fable-free live catalog', async () => {
  __resetClaudeCatalogCircuit();
  __setBrokenModelsStorePathForTests(ephemeralBrokenStorePath());
  // The authenticated subscription does not include fable, so the SDK never
  // reports it (mirrors real `supportedModels()` under the user's credentials).
  currentProbe = { supportedModels: async () => SAMPLE_LIVE_MODELS };

  try {
    const result = await getClaudeModelCatalog('user-auth-1');
    assert.equal(
      result.OPTIONS.some((o) => o.value === 'claude-fable-5'),
      false,
      'an authenticated catalog must not surface the unreleased fable model',
    );
    assert.ok(result.OPTIONS.some((o) => o.value === 'claude-opus-4-8'));
    assert.notEqual(result.degraded, true);
  } finally {
    __setBrokenModelsStorePathForTests(null);
    __resetClaudeCatalogCircuit();
  }
});

// ---------------- per-user circuit isolation ----------------
//
// The breaker is keyed per user: a subscription whose probe always fails opens
// ONLY its own breaker; another user keeps probing live and never inherits the
// failed user's open breaker.

test('getClaudeModelCatalog: the circuit breaker is isolated per user', async () => {
  __resetClaudeCatalogCircuit();
  __setBrokenModelsStorePathForTests(ephemeralBrokenStorePath());

  let failingConstructs = 0;
  currentProbe = {
    onConstruct: () => {
      failingConstructs += 1;
    },
    supportedModels: async () => {
      throw new Error('spawn failed for this user');
    },
  };

  try {
    // Three consecutive failures open user-A's breaker (threshold = 3).
    for (let i = 0; i < 3; i += 1) {
      const result = await getClaudeModelCatalog('user-A');
      assert.deepEqual(result, { ...CLAUDE_FALLBACK_MODELS, degraded: true });
    }
    assert.equal(failingConstructs, 3);

    // A 4th call for user-A is short-circuited by A's now-open breaker (no probe).
    await getClaudeModelCatalog('user-A');
    assert.equal(failingConstructs, 3, "user-A's breaker is open: no further probe spawned");

    // user-B is unaffected: its breaker is closed, so its probe runs and (now
    // returning a good list) yields a live catalog.
    let userBConstructs = 0;
    currentProbe = {
      onConstruct: () => {
        userBConstructs += 1;
      },
      supportedModels: async () => SAMPLE_LIVE_MODELS,
    };
    const resultB = await getClaudeModelCatalog('user-B');
    assert.equal(userBConstructs, 1, "user-B's breaker is independent: its probe spawns");
    assert.ok(resultB.OPTIONS.some((o) => o.value === 'claude-opus-4-8'));
    assert.notEqual(resultB.degraded, true);
  } finally {
    __setBrokenModelsStorePathForTests(null);
    __resetClaudeCatalogCircuit();
  }
});

// ---------------- lazy exclusion end-to-end ----------------
//
// A model recorded broken for a user (lazy detection, from a model_not_found/404
// at real use) must be excluded from that user's subsequent live catalog, even
// though the authenticated probe still advertises it.

test('getClaudeModelCatalog: a model recorded broken for a user is excluded from that user catalog', async () => {
  __resetClaudeCatalogCircuit();
  __setBrokenModelsStorePathForTests(ephemeralBrokenStorePath());
  // Simulate a catalog that still advertises a model the account proved broken.
  currentProbe = {
    supportedModels: async () => [
      { value: 'claude-fable-5', displayName: 'Fable 5' },
      ...SAMPLE_LIVE_MODELS,
    ],
  };

  try {
    // Before any lazy detection, the advertised model is present.
    const before = await getClaudeModelCatalog('user-lazy-1');
    assert.ok(
      before.OPTIONS.some((o) => o.value === 'claude-fable-5'),
      'model is advertised before it is proven broken',
    );

    // Record it broken for THIS user (what the send loop does on model_not_found).
    const added = await recordBrokenModel('user-lazy-1', 'claude-fable-5');
    assert.equal(added, true, 'first record returns true');

    // The next catalog for the same user excludes it.
    const after = await getClaudeModelCatalog('user-lazy-1');
    assert.equal(
      after.OPTIONS.some((o) => o.value === 'claude-fable-5'),
      false,
      'a lazily-detected broken model is hidden from the catalog',
    );
    assert.ok(after.OPTIONS.some((o) => o.value === 'claude-opus-4-8'));

    // A DIFFERENT user, who never hit the failure, still sees the model.
    const otherUser = await getClaudeModelCatalog('user-lazy-2');
    assert.ok(
      otherUser.OPTIONS.some((o) => o.value === 'claude-fable-5'),
      "another user's catalog is unaffected by the first user's broken model",
    );
  } finally {
    __setBrokenModelsStorePathForTests(null);
    __resetClaudeCatalogCircuit();
  }
});
