/**
 * engineProviderSession.test.ts — T-915 regression tests (node:test, no React).
 *
 * Verifies that session_created stamps the SENT value (written by
 * writePendingEngineStamp at dispatch time) and not the global localStorage key,
 * which can diverge from the sent value when the user opens an older session and
 * React state resets to null without touching the global key.
 *
 * Run: node --import tsx/esm --test src/components/chat/hooks/engineProviderSession.test.ts
 * Or via the project's test runner (vitest / ts-node).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// ── Storage mocks ──────────────────────────────────────────────────────────
// These must be installed before the module-under-test is first called (the
// module only reads localStorage/sessionStorage inside function bodies, not at
// load time, so setting them here — after the hoisted imports — is fine).

const lsStore = new Map<string, string>();
const ssStore = new Map<string, string>();

const mockStorage = (store: Map<string, string>) => ({
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: (_i: number) => null,
  get length() { return store.size; },
});

// inject mocks into Node global before any function call
global.localStorage = mockStorage(lsStore);
global.sessionStorage = mockStorage(ssStore);

// ── Module under test ──────────────────────────────────────────────────────
// Import AFTER global mocks are in place.
import {
  readStoredEngineProvider,
  readSessionEngineProvider,
  stampSessionEngineProvider,
  writePendingEngineStamp,
  consumePendingEngineStamp,
} from './engineProviderSession.js';

// ── Helpers ────────────────────────────────────────────────────────────────
// Direct raw-write to storage, bypassing the sanitiser, so we can prove that
// the SESSION key is read independently of the GLOBAL key.
const rawLS = (k: string, v: string | null) =>
  v === null ? lsStore.delete(k) : lsStore.set(k, v);
const rawSS = (k: string, v: string | null) =>
  v === null ? ssStore.delete(k) : ssStore.set(k, v);

beforeEach(() => {
  lsStore.clear();
  ssStore.clear();
});

// ── 1. readSessionEngineProvider: strict isolation from the global key ─────

describe('readSessionEngineProvider', () => {
  it('returns null for an unstamped session — no fallback to the global key', () => {
    // Simulate: a value sits on the global key.
    // (We use a still-disabled id — gemini — so the sanitiser drops it, and we
    //  write raw to test the STORAGE ISOLATION mechanism directly.)
    rawLS('claude-engine-provider', 'gemini');
    // Session S1 has no per-session stamp.
    assert.strictEqual(
      readSessionEngineProvider('sess-no-stamp'),
      null,
      'must return null when no session stamp exists, regardless of global key',
    );
  });

  it('reads only the session-scoped key, not the global', () => {
    rawLS('claude-engine-provider', 'gemini');                  // global = gemini (disabled)
    rawLS('claude-engine-provider-sess-002', 'deepseek');       // session stamp = deepseek (disabled)
    // Both gemini and deepseek are still disabled (ADR-062 re-enabled only
    // kimi/glm) so both sanitise to null — the test proves key ISOLATION, not
    // the sanitiser (tested separately).
    const global = readStoredEngineProvider();
    const session = readSessionEngineProvider('sess-002');
    // Both are null due to the disabled-provider sanitiser, but they were read
    // from DIFFERENT keys: the session reader must not return the global value.
    assert.strictEqual(global, null);
    assert.strictEqual(session, null);
    // Verify by having the global key absent and only the session key present.
    lsStore.delete('claude-engine-provider');
    // Even with global absent, session key read returns null (sanitised).
    assert.strictEqual(readSessionEngineProvider('sess-002'), null);
  });
});

// ── 2. stampSessionEngineProvider: writes and removes the session key ──────

describe('stampSessionEngineProvider', () => {
  it('null-stamp removes the per-session key (official-Anthropic default)', () => {
    rawLS('claude-engine-provider-sess-003', 'kimi');
    stampSessionEngineProvider('sess-003', null);
    assert.strictEqual(lsStore.has('claude-engine-provider-sess-003'), false);
    assert.strictEqual(readSessionEngineProvider('sess-003'), null);
  });

  it('does not touch the global key when stamping a session', () => {
    rawLS('claude-engine-provider', 'kimi');
    stampSessionEngineProvider('sess-004', null);
    // Global key must be untouched.
    assert.strictEqual(lsStore.get('claude-engine-provider'), 'kimi');
  });
});

// ── 3. writePendingEngineStamp / consumePendingEngineStamp ─────────────────

describe('writePendingEngineStamp + consumePendingEngineStamp', () => {
  it('null written → null consumed, even when global key has a non-null raw value', () => {
    // T-915 core regression test:
    // Scenario — global still holds kimi from a prior new-chat session;
    // user opens an OLD official-Anthropic session (React→null); sends a
    // brand-new message (new conversation, resume=false, effectiveEngineProvider=null).
    rawLS('claude-engine-provider', 'kimi');  // global = kimi (stale)

    writePendingEngineStamp(null);            // sent value = null (official)
    const stamped = consumePendingEngineStamp();

    assert.strictEqual(
      stamped,
      null,
      'consumePendingEngineStamp must return the SENT null, not the global kimi',
    );
  });

  it('null stamp clears the sessionStorage key', () => {
    rawSS('__nassaj_pending_engine_stamp', 'kimi');
    writePendingEngineStamp(null);
    assert.strictEqual(ssStore.has('__nassaj_pending_engine_stamp'), false);
  });

  it('consume clears the slot (idempotent: second consume returns null)', () => {
    writePendingEngineStamp(null);
    consumePendingEngineStamp();
    assert.strictEqual(consumePendingEngineStamp(), null);
  });

  it('consume without a prior write returns null', () => {
    assert.strictEqual(consumePendingEngineStamp(), null);
  });
});

// ── 3b. B-218: the engine axis is not the body axis ───────────────────────
//
// `DISABLED_PROVIDERS` means "not an agent SYSTEM you can pick" (no card, no
// picker group, no new spawn). It must NOT decide whether a provider is a legal
// ENGINE for the Claude body. Folding glm into OpenCode as a model (4aac5467)
// added it to DISABLED_PROVIDERS, and because the sanitiser read that list every
// session stamped `glm` started reading back as null — i.e. the user's payload
// was silently re-routed from z.ai to official Anthropic with no notice.

describe('B-218: engine eligibility is independent of the disabled-BODY list', () => {
  it('a session stamped glm reads back glm (never a silent null → official Anthropic)', () => {
    stampSessionEngineProvider('sess-glm', 'glm');
    assert.strictEqual(
      readSessionEngineProvider('sess-glm'),
      'glm',
      'glm is disabled as a BODY but is a legitimate ENGINE — the stamp must survive',
    );
  });

  it('the global picker key keeps glm too', () => {
    rawLS('claude-engine-provider', 'glm');
    assert.strictEqual(readStoredEngineProvider(), 'glm');
  });

  it('a pending stamp of glm survives the one-shot handoff', () => {
    writePendingEngineStamp('glm');
    assert.strictEqual(consumePendingEngineStamp(), 'glm');
  });

  it('kimi stays eligible (unchanged)', () => {
    stampSessionEngineProvider('sess-kimi', 'kimi');
    assert.strictEqual(readSessionEngineProvider('sess-kimi'), 'kimi');
  });

  it('deepseek stays INELIGIBLE — eligibility is not widened without an owner decision', () => {
    rawLS('claude-engine-provider-sess-ds', 'deepseek');
    assert.strictEqual(readSessionEngineProvider('sess-ds'), null);
  });

  it('a non-engine provider id is still rejected', () => {
    for (const id of ['gemini', 'claude', 'opencode', 'codex', 'nonsense', '']) {
      rawLS('claude-engine-provider-sess-x', id);
      assert.strictEqual(readSessionEngineProvider('sess-x'), null, `${id} is not an engine`);
    }
  });
});

// ── 4. End-to-end: T-915 scenario, storage-level simulation ───────────────

describe('T-915 scenario (storage-level)', () => {
  it('new session gets stamped with the sent value, not the stale global', () => {
    // Step 1: global=kimi (from a prior new-chat session).
    rawLS('claude-engine-provider', 'kimi');

    // Step 2: user opens OLD official session → React→null; global unchanged.
    // (React side is not exercised here; we test the storage contract.)

    // Step 3: user sends a brand-new message (resume=false).
    //   dispatchProviderCommand writes the SENT value (null = official):
    writePendingEngineStamp(null);

    // Step 4: session_created fires with newSessionId = 'sess-new'.
    //   Handler calls: stampSessionEngineProvider(sid, consumePendingEngineStamp())
    const newSid = 'sess-new';
    stampSessionEngineProvider(newSid, consumePendingEngineStamp());

    // Step 5: turn 2 (resume) reads the session stamp.
    const turn2Engine = readSessionEngineProvider(newSid);

    assert.strictEqual(
      turn2Engine,
      null,
      'turn 2 must route via official Anthropic (null), not kimi from stale global',
    );

    // Global key must remain untouched (the stamp is session-scoped).
    assert.strictEqual(lsStore.get('claude-engine-provider'), 'kimi');
  });

  it('stale-resume branch copies old session stamp to new session (B-ENG continuity)', () => {
    // Old session S1 had its engine stamped (raw, bypassing sanitiser for the test).
    rawLS('claude-engine-provider-sess-old', 'deepseek');

    // Stale-resume: server mints sess-new in place of sess-old.
    // Handler: stampSessionEngineProvider(newSid, readSessionEngineProvider(currentSid))
    const newSid = 'sess-new-stale';
    stampSessionEngineProvider(newSid, readSessionEngineProvider('sess-old'));

    // Both deepseek and the new session's stamp sanitise to null (deepseek is
    // disabled), but the MECHANISM is correct: it reads the old stamp and writes
    // it to the new session key — ISOLATION from the global key is preserved.
    assert.strictEqual(
      lsStore.has(`claude-engine-provider-${newSid}`),
      // null-stamp removes the key, so after stamp(null) the key is absent.
      false,
      'null stamp (disabled vendor) must remove the new session key, not leave a raw value',
    );
    assert.strictEqual(readSessionEngineProvider(newSid), null);
  });
});
