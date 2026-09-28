/**
 * T-1862 round 2 (qa LOW) — render coverage for the condensed update control:
 * no update at all (idle, hidden per IS_PLATFORM), an update available (click
 * opens the version modal), and the AGPL notice's title attribute.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Interpolates {{var}} tokens like real i18next, since the update control's
// aria-label/text rely on it (v{{version}} / "Update to v{{version}}").
function fakeT(key: string, options?: Record<string, unknown>): string {
  const template = (options?.defaultValue as string) ?? key;
  if (!options) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options[name] ?? ''));
}
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: fakeT }) }));
vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ deviceAccountSessionsEnabled: false, logout: () => {}, user: { username: 'nasser', role: 'user' } }),
}));
vi.mock('../../../../hooks/useRawExecConfig', () => ({ useRawExecQueue: () => ({ commands: [], refresh: () => {} }) }));
vi.mock('./SystemStats', () => ({ SystemStatsFooter: () => null }));
vi.mock('./UpstreamReleaseNotice', () => ({ default: () => null }));
vi.mock('./PendingActionsPanel', () => ({ default: () => null }));
vi.mock('./AccountSwitcher', () => ({ default: () => null }));

// IS_PLATFORM is read live on every render (not snapshotted at import time),
// so a mutable boxed getter lets each test flip OSS/platform mode freely.
const isPlatformBox = vi.hoisted(() => ({ value: false }));
vi.mock('../../../../constants/config', () => ({ get IS_PLATFORM() { return isPlatformBox.value; } }));

import SidebarFooter from './SidebarFooter';

const t = fakeT as any;

const baseProps = {
  restartRequired: false, actions: [], loading: false,
  execute: async () => ({ ok: true }) as any, dismiss: async () => ({ ok: true }) as any,
  releaseInfo: null, onShowSettings: () => {}, t,
};

afterEach(() => { cleanup(); isPlatformBox.value = false; });

describe('T-1862 round 2: condensed update control', () => {
  it('IS_PLATFORM with no update: renders nothing (previous behaviour restored)', () => {
    isPlatformBox.value = true;
    render(<SidebarFooter {...baseProps} updateAvailable={false} latestVersion={null} currentVersion="2.3.0.9" onShowVersionModal={() => {}} />);
    expect(screen.queryByRole('link')).toBeNull();
    // No standalone version/update button either (no aria-label matching it).
    expect(screen.queryByRole('button', { name: /2\.3\.0\.9/ })).toBeNull();
  });

  it('an available update shows the version control even on IS_PLATFORM; clicking it opens the version modal', () => {
    isPlatformBox.value = true;
    const onShowVersionModal = vi.fn();
    render(<SidebarFooter {...baseProps} updateAvailable currentVersion="2.3.0.8" latestVersion="2.3.0.9" onShowVersionModal={onShowVersionModal} />);
    const button = screen.getByRole('button', { name: /v2\.3\.0\.9/ });
    expect(button.textContent).toContain('2.3.0.8');
    expect(button.textContent).toContain('2.3.0.9');
    fireEvent.click(button);
    expect(onShowVersionModal).toHaveBeenCalledTimes(1);
  });

  it('hides the version text outright when /health failed (UNKNOWN_VERSION, "—")', () => {
    isPlatformBox.value = true;
    render(<SidebarFooter {...baseProps} updateAvailable currentVersion="—" latestVersion="2.3.0.9" onShowVersionModal={() => {}} />);
    expect(screen.queryByText(/^v—$/)).toBeNull();
  });

  it('T-1868: wraps each version number in its own <bdi dir="ltr">, and the button wrapper itself is not forced dir=ltr', () => {
    isPlatformBox.value = true;
    render(<SidebarFooter {...baseProps} updateAvailable currentVersion="2.3.0.8" latestVersion="2.3.0.9" onShowVersionModal={() => {}} />);
    const button = screen.getByRole('button', { name: /v2\.3\.0\.9/ });
    expect(button.getAttribute('dir')).toBeNull();
    const bdis = button.querySelectorAll('bdi');
    expect(bdis.length).toBe(2);
    for (const bdi of bdis) expect(bdi.getAttribute('dir')).toBe('ltr');
    expect(bdis[0].textContent).toBe('v2.3.0.8');
    expect(bdis[1].textContent).toBe('v2.3.0.9');
  });

  it('T-1868: with no unapplied update only the current version renders — no "Update to" text or second version', () => {
    isPlatformBox.value = false;
    render(<SidebarFooter {...baseProps} updateAvailable={false} currentVersion="2.3.0.9" latestVersion="2.3.0.9" onShowVersionModal={() => {}} />);
    const button = screen.getByRole('button', { name: 'Nassaj v2.3.0.9' });
    expect(button.querySelectorAll('bdi')).toHaveLength(1);
    expect(screen.queryByText('Update to')).toBeNull();
  });

  it('T-1868: only the new-version part uses the accent color; the current version stays muted', () => {
    isPlatformBox.value = true;
    render(<SidebarFooter {...baseProps} updateAvailable currentVersion="2.3.0.8" latestVersion="2.3.0.9" onShowVersionModal={() => {}} />);
    const button = screen.getByRole('button', { name: /v2\.3\.0\.9/ });
    const bdis = button.querySelectorAll('bdi');
    expect(bdis[0].className).not.toMatch(/text-primary\b/);
    expect(bdis[1].className).toMatch(/text-primary\b/);
    expect(button.className).toMatch(/text-muted-foreground/);
    expect(button.className).not.toMatch(/text-primary\b/);
  });

  it('OSS build (!IS_PLATFORM) with no update: shows the AGPL notice with its license title', () => {
    isPlatformBox.value = false;
    render(<SidebarFooter {...baseProps} updateAvailable={false} latestVersion={null} currentVersion="2.3.0.9" onShowVersionModal={() => {}} />);
    const link = screen.getByRole('link', { name: 'Open source' });
    expect(link.getAttribute('title')).toBe('common:brand.openSourceLicense');
    expect(link.getAttribute('href')).toBeTruthy();
  });
});
