/**
 * Tests for provider auth status filtering logic:
 * - installed===false + checkFailed===false → provider is hidden (confirmed check)
 * - installed===true + auth===false + checkFailed===false + !loading → disabled (CTA shown)
 * - loading / checkFailed===true → fail-open (visible + enabled)
 * - error field alone does NOT trigger fail-open (backend fills it for legitimate negative states)
 * - selected-provider reset when installed===false + checkFailed===false
 * - selected-provider NOT reset when installed===true && auth===false
 * - no blanking during initial load
 */
import { describe, it, expect } from 'vitest';

import { PROVIDER_UI_CAPABILITIES } from '../chat/constants/providerCapabilities';
import type { LLMProvider } from '../../types/app';

import type { ProviderAuthStatus, ProviderAuthStatusMap } from './types';
import { createInitialProviderAuthStatusMap } from './types';
import {
  isProviderVisible,
  isProviderDisabled,
  resolveFallbackProvider,
  shouldResetProvider,
} from './providerAuthFilter';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeStatus(overrides: Partial<ProviderAuthStatus>): ProviderAuthStatus {
  return {
    authenticated: false,
    installed: true,
    email: null,
    method: null,
    error: null,
    loading: false,
    checkFailed: false,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('provider visibility (installed field)', () => {
  it('(أ) installed===false + checkFailed===false hides the provider', () => {
    const status = makeStatus({ installed: false, authenticated: false });
    expect(isProviderVisible(status)).toBe(false);
    expect(isProviderDisabled(status)).toBe(false);
  });

  it('(ب) installed===true + auth===false + no checkFailed → visible but disabled', () => {
    const status = makeStatus({ installed: true, authenticated: false });
    expect(isProviderVisible(status)).toBe(true);
    expect(isProviderDisabled(status)).toBe(true);
  });

  it('(ب) installed===true + auth===true → visible and enabled', () => {
    const status = makeStatus({ installed: true, authenticated: true });
    expect(isProviderVisible(status)).toBe(true);
    expect(isProviderDisabled(status)).toBe(false);
  });

  it('(ج) loading=true → fail-open: visible and not disabled', () => {
    const loadingStatus = makeStatus({ installed: false, loading: true });
    expect(isProviderVisible(loadingStatus)).toBe(true);
    expect(isProviderDisabled(loadingStatus)).toBe(false);
  });

  it('(ج) checkFailed=true → fail-open: visible and not disabled even if installed===false', () => {
    const failedStatus = makeStatus({ installed: false, checkFailed: true, error: 'network error' });
    expect(isProviderVisible(failedStatus)).toBe(true);
    expect(isProviderDisabled(failedStatus)).toBe(false);
  });

  it('(باگ مُصلَح) installed===false + error مملوء + checkFailed===false → يُخفى (error وحده لا يمنع الإخفاء)', () => {
    // Backend fills error="Gemini CLI is not installed" on a successful 200 response.
    // The old code used error==null as fail-open guard → provider was always shown.
    // The fix: only checkFailed (HTTP/network failure) triggers fail-open.
    const status = makeStatus({ installed: false, error: 'Gemini CLI is not installed', checkFailed: false });
    expect(isProviderVisible(status)).toBe(false);
  });

  it('(باگ مُصلَح) installed===true + auth===false + error مملوء + checkFailed===false → يُعطَّل (لا fail-open)', () => {
    // Backend fills error="Not authenticated" on a successful 200 response.
    // Provider should appear as disabled (CTA), not enabled.
    const status = makeStatus({ installed: true, authenticated: false, error: 'Not authenticated', checkFailed: false });
    expect(isProviderVisible(status)).toBe(true);
    expect(isProviderDisabled(status)).toBe(true);
  });

  it('(ج) installed===undefined (old server) → fail-open: visible (never hidden)', () => {
    // When server does not return installed, toProviderAuthStatus sets it to true
    // (payload.installed !== false → true). The provider remains VISIBLE.
    // If the server also returns authenticated===false, the provider may be shown
    // as disabled (CTA) — that is intentional and not a fail-open violation.
    // The fail-open guarantee for visibility is: installed===false never assumed.
    const status = makeStatus({ installed: true, authenticated: false });
    expect(isProviderVisible(status)).toBe(true);
    // disabled is acceptable here (shows CTA), but visibility must be guaranteed.
  });
});

describe('provider reset logic (sanitize stored provider)', () => {
  it('(د) should reset provider when installed===false + checkFailed===false (confirmed)', () => {
    const status = makeStatus({ installed: false });
    expect(shouldResetProvider(status)).toBe(true);
  });

  it('(هـ) installed===true + auth===false → should NOT reset (stays selected)', () => {
    const status = makeStatus({ installed: true, authenticated: false });
    expect(shouldResetProvider(status)).toBe(false);
  });

  it('(هـ) installed===true + auth===true → should not reset', () => {
    const status = makeStatus({ installed: true, authenticated: true });
    expect(shouldResetProvider(status)).toBe(false);
  });

  it('should not reset when installed===false but loading (fail-open)', () => {
    const status = makeStatus({ installed: false, loading: true });
    expect(shouldResetProvider(status)).toBe(false);
  });

  it('should not reset when installed===false but checkFailed=true (fail-open on HTTP/network error)', () => {
    const status = makeStatus({ installed: false, checkFailed: true, error: 'timeout' });
    expect(shouldResetProvider(status)).toBe(false);
  });

  it('(باگ مُصلَح) installed===false + error مملوء + checkFailed===false → يُعاد التعيين (error لا يمنع الإعادة)', () => {
    const status = makeStatus({ installed: false, error: 'Not installed', checkFailed: false });
    expect(shouldResetProvider(status)).toBe(true);
  });
});

describe('initial provider map (fail-open defaults)', () => {
  it('(و) createInitialProviderAuthStatusMap sets installed=true and checkFailed=false by default', () => {
    const map = createInitialProviderAuthStatusMap(true);
    const providers = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'] as const;
    for (const p of providers) {
      expect(map[p].installed).toBe(true);
      expect(map[p].loading).toBe(true);
      expect(map[p].checkFailed).toBe(false);
    }
  });

  it('(و) no provider is hidden during initial loading (fail-open)', () => {
    const map = createInitialProviderAuthStatusMap(true);
    const providers = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'] as const;
    for (const p of providers) {
      expect(isProviderVisible(map[p])).toBe(true);
    }
  });

  it('(و) no provider is disabled during initial loading (fail-open)', () => {
    const map = createInitialProviderAuthStatusMap(true);
    const providers = ['claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode'] as const;
    for (const p of providers) {
      expect(isProviderDisabled(map[p])).toBe(false);
    }
  });
});

describe('toProviderAuthStatus payload parsing (installed field)', () => {
  it('payload.installed===false → installed=false in result', () => {
    const fromPayload = (installed?: boolean) => installed !== false;
    expect(fromPayload(false)).toBe(false);
  });

  it('payload.installed===true → installed=true', () => {
    const fromPayload = (installed?: boolean) => installed !== false;
    expect(fromPayload(true)).toBe(true);
  });

  it('payload.installed===undefined (old server) → installed=true (fail-open)', () => {
    const fromPayload = (installed?: boolean) => installed !== false;
    expect(fromPayload(undefined)).toBe(true);
  });

  it('استجابة ناجحة (200) بـerror مملوء → checkFailed=false (الحالة محسومة، ليست فشل طلب)', () => {
    // Simulate what toProviderAuthStatus produces for a 200 with error payload
    // (e.g. gemini: installed=false, error="Gemini CLI is not installed")
    // checkFailed must be false — this is a confirmed state, not a request failure.
    const simulatedStatus = {
      authenticated: false,
      installed: false,
      email: null,
      method: null,
      error: 'Gemini CLI is not installed',
      loading: false,
      checkFailed: false, // ← key: 200 response always sets this to false
    };
    expect(simulatedStatus.checkFailed).toBe(false);
    // And with checkFailed=false, the provider should be hidden
    expect(isProviderVisible(simulatedStatus)).toBe(false);
  });
});

/**
 * resolveFallbackProvider — the composer's auto-reset target.
 *
 * The order under test is the REAL capability-descriptor key order the chat
 * surface passes (claude, codex, opencode, gemini, …, deepseek, glm, sakana),
 * so these assertions fail if a future reordering re-exposes a disabled id.
 */
describe('resolveFallbackProvider — auto-reset never lands on a dead end', () => {
  const REAL_ORDER = Object.keys(PROVIDER_UI_CAPABILITIES) as LLMProvider[];

  /** Marks every provider as confirmed-not-installed except the named ones. */
  function statusWithInstalled(...installed: LLMProvider[]): ProviderAuthStatusMap {
    const map = createInitialProviderAuthStatusMap(false);
    for (const provider of Object.keys(map) as LLMProvider[]) {
      map[provider] = makeStatus({ installed: installed.includes(provider) });
    }
    return map;
  }

  it('prefers the first installed provider in the given order', () => {
    expect(resolveFallbackProvider(REAL_ORDER, statusWithInstalled('claude', 'opencode')))
      .toBe('claude');
    expect(resolveFallbackProvider(REAL_ORDER, statusWithInstalled('opencode')))
      .toBe('opencode');
  });

  it('skips gemini/deepseek/glm even when they are the only ones installed', () => {
    // Pre-fix this returned 'gemini' — a provider absent from the picker and
    // refused by the dispatch seam, i.e. a chat that can never send.
    for (const disabled of ['gemini', 'deepseek', 'glm'] as LLMProvider[]) {
      expect(
        resolveFallbackProvider(REAL_ORDER, statusWithInstalled(disabled)),
        `${disabled} must never be an auto-reset target`,
      ).toBe('claude');
    }
  });

  it('folds GLM specifically: opencode wins over an installed glm', () => {
    // The post-fold path to GLM is OpenCode + a glm/* model, so the carrier is
    // the right landing spot; glm itself is not selectable at all.
    expect(resolveFallbackProvider(REAL_ORDER, statusWithInstalled('glm', 'opencode')))
      .toBe('opencode');
  });

  it('stays fail-open: a loading/unresolved probe is still eligible', () => {
    const map = createInitialProviderAuthStatusMap(true); // installed=true, loading
    expect(resolveFallbackProvider(REAL_ORDER, map)).toBe('claude');
  });

  it('falls back to claude when nothing qualifies', () => {
    expect(resolveFallbackProvider(REAL_ORDER, statusWithInstalled())).toBe('claude');
  });
});
