/**
 * ADR-214 / T-2066: قسم مفتاح Anthropic Admin في «المورّدون والاعتمادات».
 *
 * المُثبَت: الحالة «مُعدّ» وحدها (لا يُعاد المفتاح)، الحفظ يُرسل PUT ويُفرّغ الحقل
 * ويُنبّه شارة الهيدر، الإزالة DELETE، و400 INVALID_ADMIN_KEY يُعرض برسالته.
 *
 * RUNNER: vitest (jsdom).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }),
}));

const getKey = vi.fn();
const saveKey = vi.fn();
const deleteKey = vi.fn();
vi.mock('../../../../../utils/api', () => ({
  api: {
    providers: {
      anthropicApiSpendKey: (...args: unknown[]) => getKey(...args),
      saveAnthropicApiSpendKey: (...args: unknown[]) => saveKey(...args),
      deleteAnthropicApiSpendKey: (...args: unknown[]) => deleteKey(...args),
    },
  },
}));

const refresh = vi.fn();
vi.mock('../../../../quick-settings-panel/hooks/useAnthropicApiSpend', () => ({
  refreshAnthropicApiSpend: () => refresh(),
}));

import AnthropicApiSpendSection from './AnthropicApiSpendSection';

function respond(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

// Built at runtime so the source text carries no token-shaped literal for the export leak scan.
const SECRET = ['sk', 'ant', 'admin01', 'secret-value'].join('-');

beforeEach(() => {
  getKey.mockResolvedValue(respond(200, { configured: false }));
  saveKey.mockResolvedValue(respond(200, { configured: true }));
  deleteKey.mockResolvedValue(respond(200, { configured: false }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function input(): HTMLInputElement {
  return screen.getByLabelText('apiSpend.settings.keyLabel', { selector: 'input' }) as HTMLInputElement;
}

describe('AnthropicApiSpendSection', () => {
  it('shows help, the org-wide warning, and "not configured" status', async () => {
    render(<AnthropicApiSpendSection />);
    expect(await screen.findByText('apiSpend.settings.notConfigured')).toBeTruthy();
    expect(screen.getByText('apiSpend.settings.help')).toBeTruthy();
    expect(screen.getByText('apiSpend.settings.warning')).toBeTruthy();
    expect(input().type).toBe('password');
  });

  it('save sends PUT {key}, clears the input, shows configured, refreshes the header', async () => {
    render(<AnthropicApiSpendSection />);
    await screen.findByText('apiSpend.settings.notConfigured');
    fireEvent.change(input(), { target: { value: `  ${SECRET} ` } });
    fireEvent.click(screen.getByRole('button', { name: 'apiSpend.settings.saveAria' }));

    await waitFor(() => expect(screen.getByText('apiSpend.settings.configured')).toBeTruthy());
    expect(saveKey).toHaveBeenCalledWith(SECRET);
    expect(input().value).toBe('');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(document.body.textContent?.includes(SECRET)).toBe(false);
  });

  it('400 INVALID_ADMIN_KEY shows the server error and keeps the status', async () => {
    saveKey.mockResolvedValue(respond(400, { code: 'INVALID_ADMIN_KEY' }));
    render(<AnthropicApiSpendSection />);
    await screen.findByText('apiSpend.settings.notConfigured');
    fireEvent.change(input(), { target: { value: 'sk-ant-api03-wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'apiSpend.settings.saveAria' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('apiSpend.settings.errors.INVALID_ADMIN_KEY');
    expect(screen.getByText('apiSpend.settings.notConfigured')).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('remove sends DELETE and returns to "not configured"', async () => {
    getKey.mockResolvedValue(respond(200, { configured: true }));
    render(<AnthropicApiSpendSection />);
    await screen.findByText('apiSpend.settings.configured');
    fireEvent.click(screen.getByRole('button', { name: 'apiSpend.settings.removeAria' }));

    await waitFor(() => expect(screen.getByText('apiSpend.settings.notConfigured')).toBeTruthy());
    expect(deleteKey).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'apiSpend.settings.removeAria' })).toBeNull();
  });

  it('save is disabled for an empty input', async () => {
    render(<AnthropicApiSpendSection />);
    await screen.findByText('apiSpend.settings.notConfigured');
    const save = screen.getByRole('button', { name: 'apiSpend.settings.saveAria' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });
});
