/**
 * B-748 — two accounts on one service remain distinct in the RTL settings UI.
 *
 * RUNNER: vitest (jsdom).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import arSettings from '../../../../i18n/locales/ar/settings.json';

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) =>
      node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
    arSettings,
  );
  return typeof value === 'string' ? value : undefined;
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = lookup(key) ?? (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts?.[name] === undefined ? whole : String(opts[name]),
      );
    },
    i18n: { language: 'ar' },
  }),
}));

vi.mock('../../../auth', () => ({
  useAuth: () => ({ user: { id: 7, username: 'owner', role: 'owner' } }),
}));

const connectors = [
  {
    id: 'figma-work-u7',
    service: 'figma',
    displayName: 'Figma',
    accountLabel: 'العمل',
    enabled: true,
    configured: true,
    degraded: false,
    availableNextSession: true,
    availability: 'available_next_session',
    credentialMode: 'per_member',
    ownerUserId: 7,
    allowsSharing: false,
    authMode: 'key',
    credentialSource: 'stored',
  },
  {
    id: 'figma-client-u7',
    service: 'figma',
    displayName: 'Figma',
    accountLabel: 'العميل',
    enabled: true,
    configured: true,
    degraded: false,
    availableNextSession: true,
    availability: 'available_next_session',
    credentialMode: 'per_member',
    ownerUserId: 7,
    allowsSharing: false,
    authMode: 'key',
    credentialSource: 'stored',
  },
];

const writes: Array<Record<string, unknown>> = [];

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      writes.push(body);
      return {
        ok: false,
        status: 409,
        json: async () => ({
          code: 'CONNECTOR_ALREADY_EXISTS',
          error: 'هذا الحساب مربوط مسبقاً؛ اختر اسماً مختلفاً.',
        }),
      } as Response;
    }
    const payload = url.endsWith('/catalog')
      ? {
          schemaVersion: 2,
          catalog: [
            {
              service: 'figma',
              displayName: 'Figma',
              summary: '',
              allowsSharing: false,
              official: true,
              authMode: 'key',
              additionalFields: [{ id: 'workspace', label: 'Workspace' }],
            },
          ],
        }
      : url.endsWith('/targets')
        ? { targets: [] }
        : { connectors };
    return { ok: true, status: 200, json: async () => payload } as Response;
  }),
}));

import ConnectorsSettingsTab from './ConnectorsSettingsTab';
import { resetConnectorsStore } from '../../../../stores/connectorsStore';

beforeEach(() => {
  writes.length = 0;
  resetConnectorsStore();
  document.documentElement.dir = 'rtl';
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('dir');
});

describe('B-748 تعدد حسابات الموصل', () => {
  it('يعرض حسابين للخدمة نفسها بهويتيهما ولا يسحق أحدهما', async () => {
    render(<ConnectorsSettingsTab />);

    expect(await screen.findByText('العمل')).toBeTruthy();
    expect(screen.getByText('العميل')).toBeTruthy();
    expect(screen.getAllByText('Figma')).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'أضف حساباً' })).toHaveLength(1);
  });

  it('يرسل اسم الحساب الجديد ويعرض خطأ duplicate الذي طبّعه الخادم', async () => {
    render(<ConnectorsSettingsTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'أضف حساباً' }));

    expect(screen.queryByRole('radio', { name: 'للفريق' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'لي وحدي' })).toBeNull();

    fireEvent.change(screen.getByLabelText('اسم الحساب'), { target: { value: 'العمل' } });
    fireEvent.change(screen.getByLabelText('رمز وصول شخصي'), { target: { value: 'secret' } });
    fireEvent.change(screen.getByLabelText('Workspace'), { target: { value: 'design' } });
    fireEvent.click(screen.getByRole('button', { name: 'اربط' }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({
      service: 'figma',
      accountLabel: 'العمل',
      credentialMode: 'per_member',
      additionalFields: { workspace: 'design' },
    });
    expect(writes[0]).not.toHaveProperty('extraEnv');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'هذا الحساب مربوط مسبقاً؛ اختر اسماً مختلفاً.',
    );
  });
});
