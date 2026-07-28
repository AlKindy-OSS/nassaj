/**
 * ADR-076 Wave-1b structural verification:
 *
 * 1. useGithubCredentials is a separate hook module (no longer part of
 *    useCredentialsSettings).
 * 2. useCredentialsSettings exists and is still exported (api-keys only).
 * 3. SETTINGS_MAIN_TABS api tab carries the updated "Nassaj API Keys" label.
 *
 * Intentionally lightweight — no React rendering, no HTTP mocking.
 * The hook-split contract is verified by checking that both modules export
 * their respective functions; the i18n/label contract by checking the registry.
 */
import { describe, it, expect } from 'vitest';
import { useCredentialsSettings } from '../../../hooks/useCredentialsSettings';
import { useGithubCredentials } from '../../../hooks/useGithubCredentials';
import { SETTINGS_MAIN_TABS } from '../../../constants/constants';

describe('Wave-1b: hook split — api-keys vs github credentials', () => {
  it('useCredentialsSettings is still exported as a function (api-keys domain)', () => {
    expect(typeof useCredentialsSettings).toBe('function');
  });

  it('useGithubCredentials is exported as a function from its own module', () => {
    expect(typeof useGithubCredentials).toBe('function');
  });
});

describe('Wave-1b: SETTINGS_MAIN_TABS api tab label', () => {
  it('api tab label is updated to "Nassaj API Keys"', () => {
    const entry = SETTINGS_MAIN_TABS.find((t) => t.id === 'api');
    expect(entry?.label).toBe('Nassaj API Keys');
  });

  it('api tab labelKey is still mainTabs.apiTokens', () => {
    const entry = SETTINGS_MAIN_TABS.find((t) => t.id === 'api');
    expect(entry?.labelKey).toBe('mainTabs.apiTokens');
  });

  it('git tab is still present and distinct from api tab', () => {
    const gitEntry = SETTINGS_MAIN_TABS.find((t) => t.id === 'git');
    const apiEntry = SETTINGS_MAIN_TABS.find((t) => t.id === 'api');
    expect(gitEntry).toBeDefined();
    expect(apiEntry).toBeDefined();
    expect(gitEntry?.id).not.toBe(apiEntry?.id);
  });
});
