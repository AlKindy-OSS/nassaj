/**
 * InlineModelSwitcher.local.test.tsx — T-2098 stage 3b (ADR-227 Decision 10):
 * the local blocks in the mid-chat switcher, their pin rules and the rule that no
 * surface prints the raw `local:…` pin.
 *
 * Run: npx vitest run src/components/chat/view/subcomponents/InlineModelSwitcher.local.test.tsx
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { ProviderModelsDefinition } from '../../../../types/app';

import InlineModelSwitcher from './InlineModelSwitcher';
import type { LocalOverlayServer } from './localOverlayRows';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, string>) => {
      const text = opts?.defaultValue ?? key;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => opts?.[name] ?? '');
    },
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../provider-auth/hooks/useVendorKeyStatuses', () => ({
  useVendorKeyStatuses: () => ({ statuses: { kimi: false, glm: false, deepseek: false }, loading: false, refresh: vi.fn() }),
}));

vi.mock('react-dom', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createPortal: (node: unknown) => node,
}));

const A = 'nassaj_local_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'nassaj_local_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const overlay: LocalOverlayServer[] = [
  {
    serverId: 'srv-a',
    providerId: A,
    label: 'Desk GPU',
    models: [
      { value: `${A}/qwen3:8b`, label: 'qwen3:8b', contextWindow: 32768, eligibility: 'ok' },
      { value: `${A}/mystery`, label: 'mystery', contextWindow: null, eligibility: 'context_unknown' },
    ],
  },
  {
    serverId: 'srv-b',
    providerId: B,
    label: 'Laptop',
    models: [{ value: `${B}/llama`, label: 'llama', contextWindow: 65536, eligibility: 'ok' }],
  },
];
vi.mock('../../hooks/useClaudeLocalOverlay', () => ({ useClaudeLocalOverlay: () => overlay }));

// The claude × local cell is closed until T-2103; open it here to exercise the rows.
let cellOpen = true;
vi.mock('../../../../../shared/bodyEngineMatrix', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../shared/bodyEngineMatrix')>();
  return {
    ...actual,
    actionableEngineCells: (body: string) => (
      body === 'claude' && cellOpen
        ? [...actual.actionableEngineCells(body), { engine: 'local', status: 'available', evidence: 'measured', note: '', noteDefault: '' }]
        : actual.actionableEngineCells(body)
    ),
  };
});

const catalog: Record<string, ProviderModelsDefinition> = {
  claude: { OPTIONS: [{ value: 'claude-opus-5', label: 'Opus 5' }], DEFAULT: 'claude-opus-5' },
};

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  cellOpen = true;
  cleanup();
});

function open(props: Partial<Parameters<typeof InlineModelSwitcher>[0]> = {}) {
  const onSelect = vi.fn().mockResolvedValue({ scope: 'session', model: 'x' });
  render(
    <InlineModelSwitcher
      provider="claude"
      currentModel="claude-opus-5"
      catalog={catalog}
      onSelect={onSelect}
      {...props}
    />,
  );
  fireEvent.click(screen.getByRole('button', { expanded: false }));
  return onSelect;
}

const option = (name: string) => screen.getByRole('option', { name: new RegExp(name) });

describe('new chat', () => {
  it('lists each server block and sends the model with engine=local', async () => {
    const onSelect = open({ sessionId: null });
    expect(screen.getByText('Local models · Desk GPU')).toBeTruthy();
    expect(screen.getByText('Local models · Laptop')).toBeTruthy();
    fireEvent.click(option('qwen3:8b'));
    await Promise.resolve();
    expect(onSelect).toHaveBeenCalledWith(`${A}/qwen3:8b`, 'local');
  });

  it('disables an ineligible row with its reason and a settings link', () => {
    open({ sessionId: null });
    const row = option('mystery') as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(screen.getByText('Set the context window')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Server settings' })).toBeTruthy();
  });

  it('shows no local row while the matrix cell is closed', () => {
    cellOpen = false;
    open({ sessionId: null });
    expect(screen.queryByText(/Local models ·/)).toBeNull();
  });
});

describe('existing chats', () => {
  it('an Anthropic chat shows local rows disabled with "start a new chat"', () => {
    open({ sessionId: 's1' });
    expect((option('qwen3:8b') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText('Start a new chat').length).toBe(3);
  });

  it('a local chat offers only its own server and no Anthropic row', () => {
    open({ sessionId: 's1', currentModel: `${A}/qwen3:8b`, engineProvider: 'local' });
    expect(screen.queryByRole('option', { name: /Opus 5/ })).toBeNull();
    expect((option('qwen3:8b') as HTMLButtonElement).disabled).toBe(false);
    expect((option('llama') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Runs on another server; start a new chat')).toBeTruthy();
    expect(screen.getByText('On Your local server · Desk GPU')).toBeTruthy();
  });

  it('names a deleted server and never prints the raw pin', () => {
    const gone = 'nassaj_local_cccccccccccccccccccccccccccccccc/old';
    open({ sessionId: 's1', currentModel: gone, engineProvider: 'local' });
    expect(screen.getByText('On Deleted local server')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/local:[^:\s]+:\d+:/);
  });
});
