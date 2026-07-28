/**
 * credentialTargetLabels.test.tsx — a credential target is never shown as a
 * raw wire id.
 *
 * The OpenCode card's target picker lists the ids opencode keys its `auth.json`
 * entries by (`anthropic`, `openai`, `openrouter`, `glm`). Those ids must stay
 * byte-identical on the wire — renaming `glm` would orphan the stored
 * credential and the provider block — but a lowercase `glm` sitting between
 * `Anthropic` and `OpenRouter` reads as a bug, so the DISPLAY is separated from
 * the id: an i18n label per target, and a brand-cased fallback for any target
 * that lands before its label does.
 *
 * `t` here resolves against the REAL en/settings.json, so a missing or
 * regressed label fails the test instead of being papered over by a mock.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../i18n/locales/en/settings.json';

/** Walks a dotted i18n key into the real locale bundle. */
function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    enSettings,
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      lookupOrDefault(key, opts?.defaultValue as string | undefined),
    i18n: { language: 'en' },
  }),
}));

function lookupOrDefault(key: string, defaultValue?: string): string {
  return lookup(key) ?? defaultValue ?? key;
}

// The live capability descriptor and the key-status probe both hit the backend;
// stub them so this stays a pure rendering test of the label seam.
const TARGETS = ['anthropic', 'openai', 'openrouter', 'glm'] as const;

vi.mock('./hooks/useProviderApiKeyCapability', () => ({
  useProviderApiKeyCapability: () => ({
    capability: { method: 'native_file', targets: TARGETS },
    loading: false,
  }),
}));

vi.mock('./hooks/useProviderApiKey', () => ({
  useProviderApiKey: () => ({
    configured: false,
    loading: false,
    saving: false,
    error: null,
    saveKey: async () => ({ success: true }),
    deleteKey: async () => ({ success: true }),
  }),
}));

import ProviderApiKeySection from '../settings/view/tabs/agents-settings/sections/content/ProviderApiKeySection';

import { formatCredentialTargetFallback } from './providerApiKeyMeta';

afterEach(cleanup);

describe('OpenCode credential targets — display casing', () => {
  it('shows GLM brand-cased, exactly like its sibling targets', () => {
    render(<ProviderApiKeySection provider="opencode" />);

    for (const label of ['Anthropic', 'OpenAI', 'OpenRouter', 'GLM']) {
      expect(screen.getByRole('button', { name: label }), `${label} target pill`).toBeTruthy();
    }
  });

  it('never renders a target as its raw lowercase wire id', () => {
    render(<ProviderApiKeySection provider="opencode" />);

    for (const target of TARGETS) {
      expect(screen.queryByRole('button', { name: target }), `raw "${target}" pill`).toBeNull();
    }
  });
});

describe('formatCredentialTargetFallback — targets that arrive before their label', () => {
  it('reads a short all-letter id as an acronym', () => {
    expect(formatCredentialTargetFallback('glm')).toBe('GLM');
    expect(formatCredentialTargetFallback('xai')).toBe('XAI');
  });

  it('capitalizes anything longer instead of leaving it lowercase', () => {
    expect(formatCredentialTargetFallback('zhipu')).toBe('Zhipu');
    expect(formatCredentialTargetFallback('moonshot')).toBe('Moonshot');
  });

  it('leaves an empty id alone rather than inventing a label', () => {
    expect(formatCredentialTargetFallback('')).toBe('');
  });
});
