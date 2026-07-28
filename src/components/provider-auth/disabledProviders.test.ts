/**
 * Tests for the globally-disabled-providers seam (T-864, updated per ADR-062
 * and the 2026-07-26 owner decision on GLM, shared/disabledProviders.ts — the
 * single source of truth):
 * - the disabled set is exactly gemini/deepseek/glm (kimi stays re-enabled as a
 *   governed agent environment per ADR-062; glm is folded into the OpenCode
 *   carrier and is no longer a standalone agent system);
 * - the enabled set (claude/opencode/antigravity/cursor/codex/hermes) is intact;
 * - CLI_PROVIDERS (auth-status probe fan-out) contains no disabled provider;
 * - ENABLED_VENDOR_PROVIDERS is exactly [kimi] (deepseek and glm stay
 *   disabled), and VENDOR_PROVIDERS itself stays complete (historical session
 *   rendering and type guards must keep recognizing the ids);
 * - the ENGINE axis (ADR-073, shared/engineProviders.ts) is a SEPARATE list —
 *   [kimi, glm] — because a provider being unavailable as a body says nothing
 *   about its endpoint being a legal engine for the Claude body (B-218);
 * - sanitizeStoredProvider never revives a persisted disabled selection;
 * - filterDisabledProviders preserves order and does not mutate its input.
 */
import { describe, it, expect } from 'vitest';

import {
  DISABLED_PROVIDERS,
  filterDisabledProviders,
  isProviderGloballyDisabled,
} from '../../../shared/disabledProviders';
import { engineProviderHost, isEngineProviderEligible } from '../../../shared/engineProviders';
import { DEFAULT_PROVIDER, sanitizeStoredProvider } from '../../constants/providerModelFallbacks';

import { CLI_PROVIDERS } from './types';
import {
  ENABLED_VENDOR_PROVIDERS,
  ENGINE_VENDOR_PROVIDERS,
  VENDOR_PROVIDERS,
  isVendorProvider,
} from './vendorProviders';

describe('shared/disabledProviders — single source of truth', () => {
  it('disables exactly gemini, deepseek and glm (kimi re-enabled per ADR-062)', () => {
    expect([...DISABLED_PROVIDERS].sort()).toEqual(['deepseek', 'gemini', 'glm']);
  });

  it('keeps opencode enabled — it is the body that carries GLM', () => {
    // The GLM fold must never take its carrier down with it: opencode stays a
    // first-class agent system and remains the only path to a glm/* model.
    expect(isProviderGloballyDisabled('opencode')).toBe(false);
    expect(isProviderGloballyDisabled('glm')).toBe(true);
  });

  it('keeps the six enabled providers untouched', () => {
    for (const provider of ['claude', 'opencode', 'antigravity', 'cursor', 'codex', 'hermes']) {
      expect(isProviderGloballyDisabled(provider)).toBe(false);
    }
  });

  it('filterDisabledProviders preserves order and does not mutate its input', () => {
    const input = ['claude', 'gemini', 'cursor', 'deepseek', 'hermes'];
    const output = filterDisabledProviders(input);
    expect(output).toEqual(['claude', 'cursor', 'hermes']);
    expect(input).toHaveLength(5);
  });
});

describe('CLI_PROVIDERS — auth-status probe fan-out', () => {
  it('contains no globally disabled provider (no probe, no login CTA)', () => {
    for (const provider of DISABLED_PROVIDERS) {
      expect(CLI_PROVIDERS).not.toContain(provider);
    }
  });

  it('still probes the enabled providers (incl. re-enabled kimi, without glm)', () => {
    // kimi re-enabled per ADR-062 → probed so the key-entry UI reflects its
    // connection state; deepseek and glm stay filtered. Probing glm is what
    // produced the misleading standalone "Connected" badge fed by a key store
    // the OpenCode carrier never reads.
    expect(CLI_PROVIDERS).toEqual([
      'claude',
      'cursor',
      'codex',
      'antigravity',
      'opencode',
      'hermes',
      'kimi',
    ]);
  });
});

describe('vendor providers — the BODY axis vs the ENGINE axis (ADR-073)', () => {
  it('ENABLED_VENDOR_PROVIDERS (bodies) is [kimi] (deepseek and glm stay disabled)', () => {
    expect(ENABLED_VENDOR_PROVIDERS).toEqual(['kimi']);
  });

  it('ENGINE_VENDOR_PROVIDERS (engines) is [kimi, glm] — NOT the body list', () => {
    // B-218: these two lists answer different questions and must be allowed to
    // differ. glm is not an agent system you can pick, and is still a perfectly
    // good engine for the Claude body. Deriving the engine list from the body
    // list is what made every glm-stamped session read back as "no engine" —
    // i.e. silently re-routed to official Anthropic.
    expect([...ENGINE_VENDOR_PROVIDERS]).toEqual(['kimi', 'glm']);
    expect(ENGINE_VENDOR_PROVIDERS).not.toEqual(ENABLED_VENDOR_PROVIDERS);
  });

  it('engine eligibility is not widened to deepseek without an owner decision', () => {
    expect(isEngineProviderEligible('deepseek')).toBe(false);
    expect(isEngineProviderEligible('glm')).toBe(true);
    expect(isEngineProviderEligible('kimi')).toBe(true);
    // A body id that is not an engine at all is never eligible.
    expect(isEngineProviderEligible('opencode')).toBe(false);
  });

  it('an engine names the host it will really be called on', () => {
    // Truthful display starts at the data: the surface never invents a host.
    expect(engineProviderHost('glm')).toBe('api.z.ai');
    expect(engineProviderHost('kimi')).toBe('api.moonshot.ai');
    expect(engineProviderHost('opencode')).toBeNull();
  });

  it('VENDOR_PROVIDERS stays complete so historical ids keep resolving', () => {
    expect([...VENDOR_PROVIDERS]).toEqual(['kimi', 'deepseek', 'glm']);
    expect(isVendorProvider('kimi')).toBe(true);
  });
});

describe('sanitizeStoredProvider — persisted selection of a disabled provider', () => {
  it('falls back to the default provider for every disabled id', () => {
    for (const provider of DISABLED_PROVIDERS) {
      expect(sanitizeStoredProvider(provider)).toBe(DEFAULT_PROVIDER);
    }
  });

  it('keeps a persisted enabled provider as-is', () => {
    expect(sanitizeStoredProvider('opencode')).toBe('opencode');
    expect(sanitizeStoredProvider('hermes')).toBe('hermes');
  });
});
