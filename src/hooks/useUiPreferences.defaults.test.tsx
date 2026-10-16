/**
 * تفضيلا «الوكيل الافتراضي» و«وضع التفويض الافتراضي» في مخزن تفضيلات الواجهة:
 * القيم الصالحة تُقرأ، والتالفة تسقط على الافتراضي (`''` و`delegate`).
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { __resetUiPreferencesStoreForTests, parseCoordinationLevel, useUiPreferences } from './useUiPreferences';

const readWith = (stored: Record<string, unknown>) => {
  localStorage.setItem('uiPreferences', JSON.stringify(stored));
  return renderHook(() => useUiPreferences()).result.current.preferences;
};

beforeEach(() => {
  localStorage.clear();
  __resetUiPreferencesStoreForTests();
});

describe('تفضيلات الافتراضيات', () => {
  it('بلا قيمة مخزَّنة: لا وكيل افتراضي، والتفويض delegate', () => {
    const prefs = renderHook(() => useUiPreferences()).result.current.preferences;
    expect(prefs.defaultSettingsAgent).toBe('');
    expect(prefs.defaultCoordinationLevel).toBe('delegate');
  });

  it('القيم الصالحة تُقرأ كما خُزِّنت', () => {
    const prefs = readWith({ defaultSettingsAgent: 'codex', defaultCoordinationLevel: 'direct' });
    expect(prefs.defaultSettingsAgent).toBe('codex');
    expect(prefs.defaultCoordinationLevel).toBe('direct');
  });

  it('القيم التالفة تسقط على الافتراضي', () => {
    const prefs = readWith({ defaultSettingsAgent: 'Not An Id!', defaultCoordinationLevel: 'bogus' });
    expect(prefs.defaultSettingsAgent).toBe('');
    expect(prefs.defaultCoordinationLevel).toBe('delegate');
  });

  it('parseCoordinationLevel يقبل المستويات الثلاثة وحدها', () => {
    expect(parseCoordinationLevel('delegate_review')).toBe('delegate_review');
    expect(parseCoordinationLevel(42)).toBe('delegate');
    expect(parseCoordinationLevel(null, 'direct')).toBe('direct');
  });
});
