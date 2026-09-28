/**
 * T-1862 round 2 (qa LOW) — the "Show hardware usage" row that replaced the
 * SidebarFooter/SidebarCollapsed Cpu buttons must actually exist in View
 * Options and drive the same `showHardwareUsage` preference.
 *
 * RUNNER: vitest — jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => String(options?.defaultValue ?? key),
    i18n: { language: 'ar' },
  }),
}));
vi.mock('../../../shared/view/ui', () => ({ DarkModeToggle: () => null }));
vi.mock('../../../shared/view/ui/LanguageSelector', () => ({ default: () => null }));
vi.mock('./ClaudeUsageSection', () => ({ default: () => null }));
vi.mock('./SubscriptionsSection', () => ({ default: () => null }));

import QuickSettingsContent from './QuickSettingsContent';
import type { QuickSettingsPreferences } from '../types';

const preferences: QuickSettingsPreferences = {
  autoExpandTools: false,
  showRawParameters: false,
  showThinking: false,
  showToolCalls: false,
  autoScrollToBottom: true,
  tabsIconOnly: false,
  showHardwareUsage: false,
};

afterEach(() => cleanup());

describe('T-1862 round 2: quick-settings showHardwareUsage row', () => {
  it('renders an unchecked "quickSettings.showHardwareUsage" toggle when the preference is off', () => {
    render(
      <QuickSettingsContent
        isDarkMode={false} isOpen preferences={preferences} onPreferenceChange={() => {}}
        enterBehavior="auto" onEnterBehaviorChange={() => {}} enterAutoSends
      />,
    );
    const checkbox = screen.getByText('quickSettings.showHardwareUsage').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('checking it calls onPreferenceChange with the showHardwareUsage key', () => {
    const onPreferenceChange = vi.fn();
    render(
      <QuickSettingsContent
        isDarkMode={false} isOpen preferences={preferences} onPreferenceChange={onPreferenceChange}
        enterBehavior="auto" onEnterBehaviorChange={() => {}} enterAutoSends
      />,
    );
    const checkbox = screen.getByText('quickSettings.showHardwareUsage').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(onPreferenceChange).toHaveBeenCalledWith('showHardwareUsage', true);
  });

  it('reflects an already-enabled preference as checked', () => {
    render(
      <QuickSettingsContent
        isDarkMode={false} isOpen preferences={{ ...preferences, showHardwareUsage: true }} onPreferenceChange={() => {}}
        enterBehavior="auto" onEnterBehaviorChange={() => {}} enterAutoSends
      />,
    );
    const checkbox = screen.getByText('quickSettings.showHardwareUsage').closest('label')!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });
});
