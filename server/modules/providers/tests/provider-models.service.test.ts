import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createProviderModelsService,
  PROVIDER_MODELS_CACHE_TTL_MS,
  PROVIDER_MODELS_DEGRADED_CACHE_TTL_MS,
} from '@/modules/providers/services/provider-models.service.js';
import type {
  ProviderChangeActiveModelInput,
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelsDefinition,
  ProviderSessionActiveModelChange,
} from '@/shared/types.js';
import { writeProviderSessionActiveModelChange } from '@/shared/utils.js';

const createModels = (value: string): ProviderModelsDefinition => ({
  OPTIONS: [{ value, label: value }],
  DEFAULT: value,
});

const createCurrentActiveModel = (model: string): ProviderCurrentActiveModel => ({
  model,
});

const createSessionActiveModelChange = (
  provider: LLMProvider,
  input: ProviderChangeActiveModelInput,
): ProviderSessionActiveModelChange => ({
  provider,
  sessionId: input.sessionId,
  supported: true,
  changed: true,
  model: input.model,
});

const createEphemeralCachePath = (): string => path.join(
  os.tmpdir(),
  `provider-model-cache-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`,
);

test('provider models service delegates to the resolved provider model adapter', async () => {
  const calls: LLMProvider[] = [];
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => {
      calls.push(provider);
      return {
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      };
    },
  });

  const models = await service.getProviderModels('codex', { bypassCache: true });

  assert.deepEqual(calls, ['codex']);
  assert.equal(models.models.DEFAULT, 'codex-models');
  assert.equal(models.cache.source, 'fresh');
});

test('provider models service returns each provider adapter result without rewriting it', async () => {
  const expectedModels: ProviderModelsDefinition = {
    OPTIONS: [
      { value: 'cursor-a', label: 'Cursor A' },
      { value: 'cursor-b', label: 'Cursor B' },
    ],
    DEFAULT: 'cursor-b',
  };

  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: () => ({
      models: {
        getSupportedModels: async () => expectedModels,
        getCurrentActiveModel: async () => createCurrentActiveModel('cursor-active'),
        changeActiveModel: async (input) => createSessionActiveModelChange('cursor', input),
      },
    }),
  });

  const models = await service.getProviderModels('cursor', { bypassCache: true });

  assert.deepEqual(models.models, expectedModels);
});

test('provider models are cached for the three-day ttl', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-ttl-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    const first = await service.getProviderModels('codex');
    const cached = await service.getProviderModels('codex');
    assert.equal(loadCount, 1);
    assert.equal(cached.models.DEFAULT, first.models.DEFAULT);
    assert.equal(cached.cache.source, 'memory');

    currentTime += PROVIDER_MODELS_CACHE_TTL_MS - 1;
    await service.getProviderModels('codex');
    assert.equal(loadCount, 1);

    // Just past the TTL: stale-while-revalidate serves the cached entry
    // immediately (still codex-1) and kicks off the refresh in the background,
    // so the request itself does NOT block on the fetch.
    currentTime += 2;
    const stale = await service.getProviderModels('codex');
    assert.equal(stale.models.DEFAULT, 'codex-1');
    assert.equal(stale.cache.source, 'memory');

    // The background refresh runs after the current task; await a microtask/macro
    // turn so it can settle, then the next read sees the fresh catalog.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loadCount, 2, 'background refresh ran after the stale read');

    const refreshed = await service.getProviderModels('codex');
    assert.equal(loadCount, 2, 'fresh entry served from cache, no extra fetch');
    assert.equal(refreshed.models.DEFAULT, 'codex-2');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('stale-while-revalidate: an expired entry is served instantly while refreshing in the background', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-swr-'));
  let currentTime = 1_000;
  let loadCount = 0;
  // Held in an object so control-flow analysis cannot narrow the field to `never`
  // after the async refresh assigns it.
  const slowFetch: { resolve: (() => void) | null } = { resolve: null };

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            if (loadCount === 1) {
              return createModels(`${provider}-1`);
            }
            // The background refresh is slow: it must NOT block the stale read.
            await new Promise<void>((resolve) => {
              slowFetch.resolve = resolve;
            });
            return createModels(`${provider}-2`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    // Prime the cache.
    const first = await service.getProviderModels('claude');
    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(loadCount, 1);

    // Expire it, then read again: the stale value comes back immediately even
    // though the background refresh is still pending (resolveSlowFetch not yet
    // called), proving the live fetch is off the request hot path.
    currentTime += PROVIDER_MODELS_CACHE_TTL_MS + 1;
    const stale = await service.getProviderModels('claude');
    assert.equal(stale.models.DEFAULT, 'claude-1', 'stale entry served instantly');
    assert.equal(loadCount, 2, 'background refresh was triggered');
    assert.ok(slowFetch.resolve, 'background refresh is in-flight (still pending)');

    // Let the background refresh finish, then the next read sees the fresh value.
    slowFetch.resolve?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const refreshed = await service.getProviderModels('claude');
    assert.equal(refreshed.models.DEFAULT, 'claude-2');
    assert.equal(loadCount, 2, 'no additional fetch beyond the single background refresh');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('degraded provider catalog is cached under the short ttl, not the three-day ttl', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-degraded-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            // Simulate a provider that degrades to a fallback catalog.
            return { ...createModels(`${provider}-${loadCount}`), degraded: true };
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    const first = await service.getProviderModels('antigravity');
    assert.equal(loadCount, 1);
    assert.equal(first.models.degraded, true);

    // Just before the short TTL elapses, the degraded result is still cached.
    currentTime += PROVIDER_MODELS_DEGRADED_CACHE_TTL_MS - 1;
    await service.getProviderModels('antigravity');
    assert.equal(loadCount, 1);

    // Just after the short TTL, the live fetch is re-attempted (in the
    // background via stale-while-revalidate) — proving the degraded result was
    // NOT pinned for the multi-day TTL. The stale read returns instantly; the
    // refresh runs after the current task.
    currentTime += 2;
    const stale = await service.getProviderModels('antigravity');
    assert.equal(stale.models.DEFAULT, 'antigravity-1', 'degraded entry served stale instantly');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(loadCount, 2, 'short TTL elapsed -> background re-fetch ran');
    const refreshed = await service.getProviderModels('antigravity');
    assert.equal(refreshed.models.DEFAULT, 'antigravity-2');

    // Guard the contrast explicitly: the short TTL is far below the long one.
    assert.ok(PROVIDER_MODELS_DEGRADED_CACHE_TTL_MS < PROVIDER_MODELS_CACHE_TTL_MS);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('provider model cache is persisted across service instances', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-file-'));
  const cachePath = path.join(tempRoot, 'models-cache.json');

  try {
    const writer = createProviderModelsService({
      cachePath,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => createModels('gemini-cached'),
          getCurrentActiveModel: async () => createCurrentActiveModel('gemini-active'),
          changeActiveModel: async (input) => createSessionActiveModelChange('gemini', input),
        },
      }),
    });
    await writer.getProviderModels('gemini');

    const reader = createProviderModelsService({
      cachePath,
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            throw new Error('loader should not be called for persisted cache hits');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('gemini-active'),
          changeActiveModel: async (input) => createSessionActiveModelChange('gemini', input),
        },
      }),
    });
    const models = await reader.getProviderModels('gemini');
    assert.equal(models.models.DEFAULT, 'gemini-cached');
    assert.equal(models.cache.source, 'disk');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('concurrent provider model requests share one load operation', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-pending-'));
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      resolveProvider: () => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return createModels('claude-cached');
          },
          getCurrentActiveModel: async () => createCurrentActiveModel('claude-active'),
          changeActiveModel: async (input) => createSessionActiveModelChange('claude', input),
        },
      }),
    });

    const [first, second] = await Promise.all([
      service.getProviderModels('claude'),
      service.getProviderModels('claude'),
    ]);

    assert.equal(loadCount, 1);
    assert.equal(first.models.DEFAULT, 'claude-cached');
    assert.equal(second.models.DEFAULT, 'claude-cached');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('bypassCache forces a fresh provider fetch and updates cache metadata', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-cache-refresh-'));
  let currentTime = 1_000;
  let loadCount = 0;

  try {
    const service = createProviderModelsService({
      cachePath: path.join(tempRoot, 'models-cache.json'),
      now: () => currentTime,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => {
            loadCount += 1;
            return createModels(`${provider}-${loadCount}`);
          },
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active-${loadCount}`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    const first = await service.getProviderModels('claude');
    currentTime += 50;
    const refreshed = await service.getProviderModels('claude', { bypassCache: true });

    assert.equal(first.models.DEFAULT, 'claude-1');
    assert.equal(refreshed.models.DEFAULT, 'claude-2');
    assert.equal(refreshed.cache.source, 'fresh');
    assert.notEqual(refreshed.cache.updatedAt, first.cache.updatedAt);
    assert.equal(loadCount, 2);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('provider models service delegates current active model lookups to the provider adapter', async () => {
  const calls: Array<{ provider: LLMProvider; sessionId?: string }> = [];
  const service = createProviderModelsService({
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async (sessionId) => {
          calls.push({ provider, sessionId });
          return createCurrentActiveModel(`${provider}-${sessionId}`);
        },
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
      },
    }),
  });

  const activeModel = await service.getCurrentActiveModel('opencode', 'session-123');

  assert.deepEqual(calls, [{ provider: 'opencode', sessionId: 'session-123' }]);
  assert.equal(activeModel.model, 'opencode-session-123');
});

test('provider models service delegates active model change requests to the provider adapter', async () => {
  const calls: Array<{ provider: LLMProvider; input: ProviderChangeActiveModelInput }> = [];
  const service = createProviderModelsService({
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        changeActiveModel: async (input) => {
          calls.push({ provider, input });
          return createSessionActiveModelChange(provider, input);
        },
      },
    }),
  });

  const changedModel = await service.changeActiveModel('claude', {
    sessionId: 'session-123',
    model: 'opus',
  });

  assert.deepEqual(calls, [{
    provider: 'claude',
    input: {
      sessionId: 'session-123',
      model: 'opus',
    },
  }]);
  assert.equal(changedModel.changed, true);
  assert.equal(changedModel.model, 'opus');
});

test('resolveResumeModel prefers a stored changed model over the requested one', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-change-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      activeModelChangesPath,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    await writeProviderSessionActiveModelChange('cursor', {
      sessionId: 'session-456',
      model: 'composer-2',
    }, {
      filePath: activeModelChangesPath,
    });

    const model = await service.resolveResumeModel('cursor', 'session-456', 'composer-2-fast');
    assert.equal(model, 'composer-2');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveResumeModel pins an existing session to its OWN model, not the requested global (B-167)', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-pin-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      cachePath: createEphemeralCachePath(),
      activeModelChangesPath,
      resolveProvider: (provider) => ({
        models: {
          getSupportedModels: async () => createModels(`${provider}-models`),
          // The session's own model, as read from the provider's per-session store
          // (opencode.db, the Claude transcript, …).
          getCurrentActiveModel: async (sessionId) =>
            createCurrentActiveModel(`own-model-for-${sessionId}`),
          changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
        },
      }),
    });

    // No explicit in-conversation re-pick was recorded, so the caller's global
    // 'leaked-global' (what the frontend sends on every turn) must be ignored in
    // favour of the model the session is actually running on. This is the leak fix.
    const model = await service.resolveResumeModel('opencode', 'session-789', 'leaked-global');
    assert.equal(model, 'own-model-for-session-789');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('resolveResumeModel uses the requested global for a brand-new conversation (B-167 req 3)', async () => {
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async () => createModels(`${provider}-models`),
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
      },
    }),
  });

  // No sessionId yet -> a freshly minted conversation inherits the caller's
  // current picker selection.
  const model = await service.resolveResumeModel('opencode', undefined, 'sonnet');
  assert.equal(model, 'sonnet');
});

test('getProviderModels forwards userId to the provider adapter', async () => {
  const seenUserIds: Array<string | number | null | undefined> = [];
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async (userId) => {
          seenUserIds.push(userId);
          return createModels(`${provider}-models`);
        },
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
      },
    }),
  });

  await service.getProviderModels('claude', { bypassCache: true }, 'user-42');
  assert.deepEqual(seenUserIds, ['user-42'], 'the adapter receives the request userId');
});

test('getProviderModels caches per user: two users get independent catalogs', async () => {
  let loadCount = 0;
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => ({
      models: {
        // Each user sees a model value tagged with the userId, so we can prove the
        // cache did not bleed one user's catalog into the other.
        getSupportedModels: async (userId) => {
          loadCount += 1;
          return createModels(`${provider}-${String(userId)}`);
        },
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
      },
    }),
  });

  // First fetch for each user populates a SEPARATE cache entry.
  const a1 = await service.getProviderModels('claude', {}, 'user-A');
  const b1 = await service.getProviderModels('claude', {}, 'user-B');
  assert.equal(a1.models.DEFAULT, 'claude-user-A');
  assert.equal(b1.models.DEFAULT, 'claude-user-B');
  assert.equal(loadCount, 2, 'each user triggered its own load');

  // Second fetch for user-A is served from user-A's cache (no extra load) and is
  // still user-A's catalog, not user-B's.
  const a2 = await service.getProviderModels('claude', {}, 'user-A');
  assert.equal(a2.models.DEFAULT, 'claude-user-A');
  assert.equal(a2.cache.source, 'memory');
  assert.equal(loadCount, 2, 'cached per-user hit, no extra load');
});

test('getProviderModels with no userId uses the shared bare-provider cache key (unchanged behaviour)', async () => {
  let loadCount = 0;
  const service = createProviderModelsService({
    cachePath: createEphemeralCachePath(),
    resolveProvider: (provider) => ({
      models: {
        getSupportedModels: async (userId) => {
          loadCount += 1;
          // No user -> adapter receives null (the shared bucket).
          assert.equal(userId, null);
          return createModels(`${provider}-shared`);
        },
        getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-active`),
        changeActiveModel: async (input) => createSessionActiveModelChange(provider, input),
      },
    }),
  });

  const first = await service.getProviderModels('claude');
  const second = await service.getProviderModels('claude');
  assert.equal(first.models.DEFAULT, 'claude-shared');
  assert.equal(second.cache.source, 'memory');
  assert.equal(loadCount, 1, 'the shared key caches across no-userId calls');
});

// ---- seedSessionModel: pin a memoryless session at creation (T-874(2)) ----

const memorylessAdapter = (provider: LLMProvider) => ({
  models: {
    getSupportedModels: async () => createModels(`${provider}-models`),
    // A memoryless provider (gemini/codex/hermes/vendors) has no per-session
    // model of its own, so getCurrentActiveModel only ever returns the catalog
    // default — NOT the model a given session was created with.
    getCurrentActiveModel: async () => createCurrentActiveModel(`${provider}-default`),
    changeActiveModel: async (input: ProviderChangeActiveModelInput) =>
      createSessionActiveModelChange(provider, input),
  },
});

test('seedSessionModel pins a new session so resume returns the creation model, not the global (T-874(2))', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-seed-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      cachePath: createEphemeralCachePath(),
      activeModelChangesPath,
      resolveProvider: memorylessAdapter,
    });

    // Session created on 'gemini-2.5-pro'; seed pins it in the change store.
    await service.seedSessionModel('gemini', 'sess-seed-1', 'gemini-2.5-pro');

    const changed = await service.getChangedActiveModel('gemini', 'sess-seed-1');
    assert.equal(changed.changed, true, 'the seed is recorded as a pinned change');
    assert.equal(changed.model, 'gemini-2.5-pro');

    // On resume the frontend re-sends its (possibly changed) GLOBAL model; the
    // seeded creation model must win over both the global and the catalog default.
    const resumed = await service.resolveResumeModel('gemini', 'sess-seed-1', 'leaked-global');
    assert.equal(resumed, 'gemini-2.5-pro');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('seedSessionModel no-ops on an empty/whitespace model (provider default keeps applying)', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-seed-empty-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      cachePath: createEphemeralCachePath(),
      activeModelChangesPath,
      resolveProvider: memorylessAdapter,
    });

    await service.seedSessionModel('codex', 'sess-seed-2', '   ');
    await service.seedSessionModel('codex', 'sess-seed-3', undefined);

    for (const sessionId of ['sess-seed-2', 'sess-seed-3']) {
      const changed = await service.getChangedActiveModel('codex', sessionId);
      assert.equal(changed.changed, false, `${sessionId}: nothing seeded for an empty model`);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('seedSessionModel is idempotent and never clobbers an explicit re-pick', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'provider-model-seed-idem-'));
  const activeModelChangesPath = path.join(tempRoot, 'session-model-changes.json');

  try {
    const service = createProviderModelsService({
      cachePath: createEphemeralCachePath(),
      activeModelChangesPath,
      resolveProvider: memorylessAdapter,
    });

    // An explicit in-conversation re-pick already owns this session.
    await writeProviderSessionActiveModelChange(
      'hermes',
      { sessionId: 'sess-seed-4', model: 'nous/kimi-k2.5' },
      { filePath: activeModelChangesPath },
    );

    // A (late/duplicate) creation seed must not overwrite the user's choice.
    await service.seedSessionModel('hermes', 'sess-seed-4', 'nous/minimax-m3');

    const changed = await service.getChangedActiveModel('hermes', 'sess-seed-4');
    assert.equal(changed.model, 'nous/kimi-k2.5', 'the explicit re-pick is preserved');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
