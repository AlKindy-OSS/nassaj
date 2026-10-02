/**
 * T-1946: the owner setting for the SSO-member API key window — load,
 * validation 1..365, save contract, every server refusal mapped to a message,
 * the ar/en copy explaining pause-vs-delete, Arabic day plurals, stale-status
 * clearing, load retry, and the dormant note while programmatic access is off.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../../../i18n/locales/ar/settings.json';
import enSettings from '../../../../../../i18n/locales/en/settings.json';

function lookup(tree: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    tree,
  );
  return typeof value === 'string' ? value : undefined;
}

let language: 'en' | 'ar' = 'en';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const tree = language === 'ar' ? arSettings : enSettings;
      // Mirrors i18next plural resolution (Intl.PluralRules suffix, then base key).
      const plural = typeof options?.count === 'number'
        ? lookup(tree, `${key}_${new Intl.PluralRules(language).select(options.count)}`)
        : undefined;
      const text = plural ?? lookup(tree, key) ?? key;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''));
    },
    i18n: { language },
  }),
}));

const authenticatedFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../../../../utils/api', () => ({ authenticatedFetch }));

import { parseWindowDays } from '../../../../hooks/useApiKeySsoWindow';

import ApiKeySsoWindowSection from './ApiKeySsoWindowSection';

const copy = enSettings.apiKeySsoWindow;
const limits = { defaultDays: 7, minDays: 1, maxDays: 365 };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function renderLoaded(windowDays = 7, externalApiEnabled = true) {
  authenticatedFetch.mockResolvedValueOnce(json(200, { windowDays, ...limits }));
  render(<ApiKeySsoWindowSection externalApiEnabled={externalApiEnabled} />);
  const label = (language === 'ar' ? arSettings : enSettings).apiKeySsoWindow.label;
  const input = await screen.findByLabelText(label) as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe(String(windowDays)));
  return input;
}

beforeEach(() => { language = 'en'; authenticatedFetch.mockReset(); });
afterEach(() => cleanup());

describe('parseWindowDays', () => {
  it('accepts whole days inside 1..365 only', () => {
    expect(parseWindowDays('1')).toBe(1);
    expect(parseWindowDays(' 365 ')).toBe(365);
    for (const bad of ['0', '366', '7.5', '-1', '', 'abc', '1e2']) expect(parseWindowDays(bad)).toBeNull();
  });
});

describe('ApiKeySsoWindowSection', () => {
  it('loads the current value and explains pause vs delete', async () => {
    const input = await renderLoaded(14);
    expect(authenticatedFetch).toHaveBeenCalledWith('/api/settings/api-key-sso-window');
    expect(input.min).toBe('1');
    expect(input.max).toBe('365');
    expect(screen.getByText(copy.description)).toBeTruthy();
    expect(input.getAttribute('aria-describedby')).toBeTruthy();
    expect((screen.getByRole('button', { name: copy.save }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('saves a valid value as a JSON integer and confirms', async () => {
    const input = await renderLoaded();
    authenticatedFetch.mockResolvedValueOnce(json(200, { success: true, windowDays: 30, ...limits }));
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    await screen.findByText(copy.saved);
    const [url, init] = authenticatedFetch.mock.calls[1];
    expect(url).toBe('/api/settings/api-key-sso-window');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ windowDays: 30 });
  });

  it.each(['0', '366', '7.5', ''])('blocks %j locally without calling the server', async (value) => {
    const input = await renderLoaded();
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(input.closest('form')!);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Enter a whole number of days from 1 to 365.');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, { code: 'invalid_window_days', error: 'x' }, 'Enter a whole number of days from 1 to 365.'],
    [403, { error: 'Insufficient permissions' }, copy.errors.forbidden],
    [409, { code: 'identity_changed', error: 'x' }, copy.errors.conflict],
    [500, { error: 'Failed' }, copy.errors.save],
  ])('maps server %i to a clear message', async (status, body, message) => {
    const input = await renderLoaded();
    authenticatedFetch.mockResolvedValueOnce(json(status, body));
    fireEvent.change(input, { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    expect((await screen.findByRole('alert')).textContent).toBe(message);
  });

  it('shows a load error instead of a fake default when the read fails', async () => {
    authenticatedFetch.mockResolvedValueOnce(json(403, { error: 'Insufficient permissions' }));
    render(<ApiKeySsoWindowSection externalApiEnabled />);
    expect((await screen.findByRole('alert')).textContent).toBe(copy.errors.load);
    expect(screen.queryByLabelText(copy.label)).toBeNull();
  });

  it('renders the Arabic copy', async () => {
    language = 'ar';
    authenticatedFetch.mockResolvedValueOnce(json(200, { windowDays: 7, ...limits }));
    render(<ApiKeySsoWindowSection externalApiEnabled />);
    expect(await screen.findByLabelText(arSettings.apiKeySsoWindow.label)).toBeTruthy();
    expect(screen.getByText(arSettings.apiKeySsoWindow.description)).toBeTruthy();
    expect(screen.getByRole('button', { name: arSettings.apiKeySsoWindow.save })).toBeTruthy();
  });

  it.each([
    [1, 'يوم'], [2, 'يومان'], [7, 'أيام'],
    [11, 'يوماً'], [100, 'يوم'],
  ])('uses the Arabic plural for %i days', async (days, unit) => {
    language = 'ar';
    const input = await renderLoaded(days);
    expect(input.nextElementSibling?.textContent).toBe(unit);
  });

  it('follows the draft when picking the unit form', async () => {
    language = 'ar';
    const input = await renderLoaded(7);
    fireEvent.change(input, { target: { value: '11' } });
    expect(input.nextElementSibling?.textContent).toBe('يوماً');
  });

  it('uses singular and plural English units', async () => {
    const input = await renderLoaded(1);
    expect(input.nextElementSibling?.textContent).toBe('day');
    fireEvent.change(input, { target: { value: '7' } });
    expect(input.nextElementSibling?.textContent).toBe('days');
  });

  it('drops the saved confirmation once the draft changes again', async () => {
    const input = await renderLoaded();
    authenticatedFetch.mockResolvedValueOnce(json(200, { success: true, windowDays: 30, ...limits }));
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: copy.save }));
    await screen.findByText(copy.saved);
    fireEvent.change(input, { target: { value: '31' } });
    expect(screen.queryByText(copy.saved)).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('retries a failed load', async () => {
    authenticatedFetch.mockResolvedValueOnce(json(500, { error: 'Failed' }));
    render(<ApiKeySsoWindowSection externalApiEnabled />);
    const retry = await screen.findByRole('button', { name: copy.retry });
    authenticatedFetch.mockResolvedValueOnce(json(200, { windowDays: 9, ...limits }));
    fireEvent.click(retry);
    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalledTimes(2));
    const input = await screen.findByLabelText(copy.label) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('9'));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stays editable with a dormant note while programmatic access is off', async () => {
    const input = await renderLoaded(7, false);
    expect(screen.getByText(copy.disabledNote)).toBeTruthy();
    expect(input.disabled).toBe(false);
  });

  it('hides the dormant note while programmatic access is on', async () => {
    await renderLoaded(7, true);
    expect(screen.queryByText(copy.disabledNote)).toBeNull();
  });
});

describe('T-1946 copy honesty', () => {
  it('no longer claims keys never expire without qualification', () => {
    expect(enSettings.externalApi.warning.description).not.toMatch(/The keys never expire/);
    expect(arSettings.externalApi.warning.description).not.toContain('بلا انتهاء');
    expect(enSettings.externalApi.warning.description).toMatch(/identity provider sends a sign-out notice/);
    expect(arSettings.externalApi.warning.description).toContain('إشعار خروج');
  });

  it('tells the owner that an identity-provider sign-out notice deletes the keys', () => {
    expect(copy.description).toMatch(/identity provider sends a sign-out notice/);
    expect(arSettings.apiKeySsoWindow.description).toContain('إشعار خروج');
    // A silent role withdrawal is not claimed to delete keys immediately.
    expect(copy.description).not.toMatch(/removed in Nassaj or (at )?your identity provider/);
    expect(copy.description).toMatch(/next sign-in attempt/);
  });
});
