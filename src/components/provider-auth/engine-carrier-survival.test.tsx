/**
 * engine-carrier-survival.test.tsx — tripwire for the client: what the user must
 * still see and be able to pick after the kimi / glm / deepseek / qwen / hermes /
 * cursor agent BODIES are removed from the interface.
 *
 *   - a stored engine stamp for kimi / glm / deepseek still reads back as that
 *     engine (a stamp that reads back as null runs the chat on official Anthropic);
 *   - the model picker still lists the three engines inside the Claude group,
 *     and picking one hands that engine to the composer;
 *   - the OpenCode group still lists the `glm/*` and `qwen-plan/*` carrier rows;
 *   - the key cards for Moonshot, DeepSeek, Z.AI and Alibaba Cloud still render,
 *     and the engines panel of the Claude agent still names the three engines.
 *
 * The real components and the real key-status hook run against a scripted
 * `authenticatedFetch`; nothing about keys is mocked above the network call.
 *
 * RUNNER: vitest (`npm run test:client -- <this file>`) — jsdom.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ELIGIBLE_ENGINE_PROVIDERS, engineProviderHost } from '../../../shared/engineProviders';
import { vendorsByCompany } from '../../../shared/vendors';
import type { LLMProvider, ProviderModelsDefinition } from '../../types/app';
import {
  readSessionEngineProvider,
  sanitizeEngineProviderValue,
  stampSessionEngineProvider,
} from '../chat/hooks/engineProviderSession';
import ProviderSelectionEmptyState from '../chat/view/subcomponents/ProviderSelectionEmptyState';
import { COLLAPSE_STORAGE_KEY } from '../chat/view/subcomponents/providerGroupCollapse';
import EnginesContent from '../settings/view/tabs/agents-settings/sections/content/EnginesContent';
import VendorsSettingsTab from '../settings/view/tabs/vendors-settings/VendorsSettingsTab';

import type { ProviderAuthStatus, ProviderAuthStatusMap } from './types';
import { ENGINE_VENDOR_PROVIDERS } from './vendorProviders';

// ─── Mocks (hoisted above the imports by vitest) ────────────────────────────

/** Resolves to the inline English default, with `{{name}}` interpolation. */
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = (opts?.defaultValue as string) ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
        opts && name in opts ? String(opts[name]) : whole);
    },
    i18n: { language: 'en' },
  }),
  Trans: () => null,
}));

/** Which key slots the scripted server reports as holding a key. */
let configuredSlots: Record<string, boolean> = {};
let requestedUrls: string[] = [];

vi.mock('../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string) => {
    requestedUrls.push(url);
    const companyId = /\/company\/([^/]+)\/key/.exec(url)?.[1];
    if (companyId) {
      const company = vendorsByCompany().find((entry) => entry.id === companyId);
      const slots = (company?.vendors ?? [])
        .filter((vendor) => vendor.slot !== null)
        .map((vendor) => ({
          vendorId: vendor.id,
          provider: vendor.slot!.provider,
          ...(vendor.slot!.target ? { target: vendor.slot!.target } : {}),
          configured: false,
          subscription: false,
        }));
      return {
        ok: true,
        json: async () => ({ success: true, data: { companyId, writable: true, slots } }),
      } as unknown as Response;
    }
    const provider = /\/api\/providers\/([^/]+)\/api-key/.exec(url)?.[1] ?? '';
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: { provider, configured: Boolean(configuredSlots[provider]), writable: true },
      }),
    } as unknown as Response;
  }),
}));

vi.mock('../../hooks/useFavoriteModels', () => ({
  useFavoriteModels: () => ({ favorites: [], handleToggleFavorite: vi.fn(), isLoading: false }),
}));

vi.mock('../chat/hooks/useAntigravityActiveModel', () => ({
  useAntigravityActiveModel: () => ({ label: null, loading: false, error: null }),
}));

vi.mock('../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openSettings: vi.fn() }),
}));

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ENGINES = ['kimi', 'glm', 'deepseek'] as const;

const authenticated: ProviderAuthStatus = {
  authenticated: true,
  installed: true,
  email: null,
  method: null,
  error: null,
  loading: false,
  checkFailed: false,
};

/** Auth status for every id the picker may ask about. */
const AUTH_STATUS = new Proxy({}, { get: () => authenticated }) as ProviderAuthStatusMap;

const option = (value: string, label: string) => ({ value, label });

/**
 * The catalog the server answers with: the engine catalogs under their own ids,
 * and the OpenCode listing with its carrier rows (`glm/*`, `qwen-plan/*`) beside
 * OpenCode's own paid route for the same model.
 */
const CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: { OPTIONS: [option('sonnet', 'Claude Sonnet')], DEFAULT: 'sonnet' },
  kimi: { OPTIONS: [option('kimi-k2.6', 'Kimi K2.6 engine model')], DEFAULT: 'kimi-k2.6' },
  glm: { OPTIONS: [option('glm-5.2', 'GLM 5.2 engine model')], DEFAULT: 'glm-5.2' },
  deepseek: { OPTIONS: [option('deepseek-v4-pro', 'DeepSeek V4 engine model')], DEFAULT: 'deepseek-v4-pro' },
  opencode: {
    OPTIONS: [
      option('opencode/big-pickle', 'Big Pickle'),
      option('glm/glm-5.2', 'GLM 5.2 carrier row'),
      option('qwen-plan/qwen3-coder-plus', 'Qwen3 Coder Plus carrier row'),
    ],
    DEFAULT: 'opencode/big-pickle',
  },
};

type PickerProps = ComponentProps<typeof ProviderSelectionEmptyState>;

function renderPicker(onSelectClaudeEngineProvider = vi.fn()) {
  const noop = () => {};
  // Built as a loose record: the per-body model props shrink as bodies are
  // removed, and this test must not be the thing that pins their names.
  const props = {
    selectedSession: null,
    currentSessionId: null,
    provider: 'claude',
    setProvider: noop,
    engineProvider: null,
    setEngineProvider: noop,
    onSelectClaudeEngineProvider,
    textareaRef: { current: null },
    claudeModel: 'none-selected',
    setClaudeModel: noop,
    cursorModel: '',
    setCursorModel: noop,
    codexModel: '',
    setCodexModel: noop,
    antigravityModel: '',
    setAntigravityModel: noop,
    opencodeModel: '',
    setOpenCodeModel: noop,
    hermesModel: '',
    setHermesModel: noop,
    kimiModel: '',
    setKimiModel: noop,
    deepseekModel: '',
    setDeepSeekModel: noop,
    glmModel: '',
    setGlmModel: noop,
    providerModelCatalog: CATALOG,
    providerModelsLoading: false,
    providerModelsRefreshing: false,
    providerAuthStatus: AUTH_STATUS,
    onRefreshProviderModels: vi.fn().mockResolvedValue(undefined),
    onHardRefreshProviderModels: noop,
    onRefreshAuthStatus: vi.fn().mockResolvedValue(undefined),
    setInput: noop,
  } as unknown as PickerProps;
  render(<ProviderSelectionEmptyState {...props} />);
  return { onSelectClaudeEngineProvider };
}

async function openPicker() {
  fireEvent.click(screen.getByRole('button', { name: /change model/i }));
  await screen.findByPlaceholderText('Search models...');
}

beforeEach(() => {
  configuredSlots = {};
  requestedUrls = [];
  window.localStorage.clear();
  window.sessionStorage.clear();
  // Groups start folded; open the two this test reads.
  window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify({ claude: false, opencode: false }));
  // cmdk + radix reach for APIs jsdom does not implement.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('engine stamp: a stored engine reads back as that engine', () => {
  it.each(ENGINES)('keeps "%s" as a valid engine stamp', (engine) => {
    expect(sanitizeEngineProviderValue(engine)).toBe(engine);
  });

  it('declares exactly the three engines as selectable', () => {
    expect([...ELIGIBLE_ENGINE_PROVIDERS].sort()).toEqual([...ENGINES].sort());
    expect([...ENGINE_VENDOR_PROVIDERS].sort()).toEqual([...ENGINES].sort());
  });

  it.each(['cursor', 'hermes', 'qwen', 'anthropic', '', null])('rejects %j, which was never an engine', (value) => {
    expect(sanitizeEngineProviderValue(value)).toBeNull();
  });

  it.each(ENGINES)('reads the "%s" stamp of a historical session from storage', (engine) => {
    stampSessionEngineProvider(`session-on-${engine}`, engine);
    expect(readSessionEngineProvider(`session-on-${engine}`)).toBe(engine);
  });
});

describe('model picker: engine rows and carrier rows', () => {
  it('lists every keyed engine inside the Claude group and the carrier rows under OpenCode', async () => {
    configuredSlots = { kimi: true, glm: true, deepseek: true, qwen: true };
    renderPicker();
    await openPicker();

    // Engine rows appear once the key-status round trip has answered.
    await waitFor(() => expect(screen.getByText('GLM 5.2 engine model')).toBeTruthy());
    expect(screen.getByText('Kimi K2.6 engine model')).toBeTruthy();
    expect(screen.getByText('DeepSeek V4 engine model')).toBeTruthy();

    // Each engine row names the host it will really be called on.
    expect(screen.getByText(`via ${engineProviderHost('kimi')} · your key`)).toBeTruthy();
    expect(screen.getByText(`via ${engineProviderHost('deepseek')} · your key`)).toBeTruthy();
    // The GLM engine row and the glm/* carrier row both run on z.ai.
    expect(screen.getAllByText(`via ${engineProviderHost('glm')} · your key`)).toHaveLength(2);

    // Carrier rows under OpenCode.
    expect(screen.getByText('GLM 5.2 carrier row')).toBeTruthy();
    expect(screen.getByText('Qwen3 Coder Plus carrier row')).toBeTruthy();
    expect(screen.getByText('via Alibaba Cloud · your key')).toBeTruthy();
  });

  it('asks the server for the key status of the three engines and the Qwen slot', async () => {
    renderPicker();
    await waitFor(() => {
      for (const slot of ['kimi', 'deepseek', 'glm', 'qwen']) {
        expect(requestedUrls).toContain(`/api/providers/${slot}/api-key`);
      }
    });
  });

  it.each(ENGINES)('picking the "%s" engine row hands that engine to the composer', async (engine) => {
    configuredSlots = { kimi: true, glm: true, deepseek: true };
    const { onSelectClaudeEngineProvider } = renderPicker();
    await openPicker();

    const label = CATALOG[engine]!.OPTIONS[0].label;
    const row = await screen.findByText(label);
    fireEvent.click(row);

    expect(onSelectClaudeEngineProvider).toHaveBeenCalledWith(engine, CATALOG[engine]!.DEFAULT);
  });

  it('shows a keyless engine as a locked row and withholds the qwen-plan rows', async () => {
    renderPicker();
    await openPicker();

    await waitFor(() => expect(screen.getByText('via api.z.ai · add a GLM key')).toBeTruthy());
    expect(screen.getByText('via api.moonshot.ai · add a Kimi key')).toBeTruthy();
    expect(screen.getByText('via api.deepseek.com · add a DeepSeek key')).toBeTruthy();
    expect(screen.queryByText('GLM 5.2 engine model')).toBeNull();

    // The glm/* carrier row is OpenCode's own listing and stays; qwen-plan needs the key.
    expect(screen.getByText('GLM 5.2 carrier row')).toBeTruthy();
    expect(screen.queryByText('Qwen3 Coder Plus carrier row')).toBeNull();
  });
});

describe('settings: key cards and the engines panel', () => {
  it('renders a key field for Moonshot, DeepSeek, Z.AI and Alibaba Cloud', async () => {
    render(<VendorsSettingsTab />);
    for (const companyId of ['moonshot', 'deepseek', 'zai', 'alibaba-cloud']) {
      await waitFor(() =>
        expect(document.getElementById(`company-api-key-${companyId}`), companyId).not.toBeNull());
    }
  });

  it('names the three engines and their hosts on the Claude agent', async () => {
    render(<EnginesContent agent="claude" />);
    await waitFor(() => expect(screen.getByText('GLM')).toBeTruthy());
    expect(screen.getByText('Kimi')).toBeTruthy();
    expect(screen.getByText('DeepSeek')).toBeTruthy();
    for (const engine of ENGINES) {
      expect(screen.getByText(engineProviderHost(engine)!)).toBeTruthy();
    }
  });
});
