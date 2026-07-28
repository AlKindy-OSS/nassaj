/**
 * enginesSurface.test.tsx — the engine axis, now read inside the body it belongs to.
 *
 * History this file carries forward. The 2026-07-26 fold removed the GLM card
 * from the Agents screen — correctly, because that screen lists agent SYSTEMS (a
 * body with a CLI, tools, sessions) and GLM has no body. But that card was also
 * the ONLY way to write `getProviderKey(userId, 'glm')`, so folding it away
 * silently removed the only path to store an engine key (B-217). The repair gave
 * engines a surface of their own, as a top-level tab beside Agents.
 *
 * That tab was right about the axis and wrong about the place: engines listed
 * with no body in sight, bodies listed with no engine in sight, and the question
 * both axes exist to answer — *what can THIS agent run on?* — asked by neither.
 * The axis now lives as a category of each agent, next to its permissions.
 *
 * These tests assert what the operator actually sees and can do:
 *   - the settings shell no longer offers a top-level Engines destination, and
 *     the Agents destination it moved into is untouched;
 *   - each body shows ITS OWN engines — Claude's row is not Codex's row;
 *   - the endpoint each engine will really be called on is shown (truthfulness:
 *     z.ai's own guide advertises "you see a Claude model while GLM runs" — the
 *     exact thing this surface must never do);
 *   - evidence is rendered, so an inference is never dressed as a demonstration;
 *   - a key entry appears only where a key is the remaining barrier, never on a
 *     cell that is closed at the vendor;
 *   - the status reflects the live key store, and never asserts "connected";
 *   - saving/removing a key hits that engine's own endpoint.
 *
 * `t` resolves against the REAL en/settings.json, so a missing label fails here
 * instead of silently rendering an English defaultValue in every locale.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../../../../i18n/locales/en/settings.json';

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    enSettings,
  );
  return typeof value === 'string' ? value : undefined;
}

/** Mirrors i18next interpolation closely enough for assertions. */
function interpolate(template: string, opts?: Record<string, unknown>): string {
  if (!opts) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    opts[name] === undefined ? whole : String(opts[name]),
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      interpolate(lookup(key) ?? (opts?.defaultValue as string) ?? key, opts),
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

vi.mock('../../../../auth', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: 'owner' } }),
}));

// The key store is reached through authenticatedFetch; script it per test.
const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
let configuredByProvider: Record<string, boolean> = {};

vi.mock('../../../../../utils/api', () => ({
  authenticatedFetch: vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    const provider = /\/api\/providers\/([^/]+)\/api-key/.exec(url)?.[1] ?? '';
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      configuredByProvider[provider] = true;
    } else if (method === 'DELETE') {
      configuredByProvider[provider] = false;
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        data: { provider, configured: Boolean(configuredByProvider[provider]) },
      }),
    } as unknown as Response;
  }),
}));

import SettingsSidebar from '../../SettingsSidebar';

import EnginesContent from './sections/content/EnginesContent';

beforeEach(() => {
  fetchCalls.length = 0;
  configuredByProvider = {};
});

afterEach(cleanup);

describe('the settings shell no longer splits the two axes', () => {
  it('offers no top-level Engines destination', () => {
    render(<SettingsSidebar activeTab="agents" onChange={() => {}} />);
    expect(screen.queryAllByRole('button', { name: /^engines$/i })).toHaveLength(0);
  });

  it('keeps the Agents destination the engines moved into', () => {
    render(<SettingsSidebar activeTab="agents" onChange={() => {}} />);
    expect(screen.getAllByRole('button', { name: /agents/i }).length).toBeGreaterThan(0);
  });
});

describe('a body shows its own engines', () => {
  it('lists the Claude body row, GLM included', async () => {
    render(<EnginesContent agent="claude" />);
    await waitFor(() => expect(screen.getByText('GLM')).toBeTruthy());
    expect(screen.getByText('Anthropic')).toBeTruthy();
    expect(screen.getByText('Kimi')).toBeTruthy();
  });

  it('does not show one body row on another body', async () => {
    render(<EnginesContent agent="codex" />);
    // Codex's own reason for GLM, not Claude's.
    await waitFor(() => expect(screen.getByText(lookup('engines.cell.codexGlm')!)).toBeTruthy());
    expect(screen.queryByText(lookup('engines.cell.claudeGlm')!)).toBeNull();
  });

  it('names the endpoint each engine will really be called on', async () => {
    render(<EnginesContent agent="claude" />);
    await waitFor(() => expect(screen.getByText('api.z.ai')).toBeTruthy());
    expect(screen.getByText('api.moonshot.ai')).toBeTruthy();
  });

  it('marks a measured cell apart from an inferred one', async () => {
    render(<EnginesContent agent="claude" />);
    await waitFor(() => expect(screen.getAllByText(lookup('engines.evidence.measured')!).length).toBeGreaterThan(0));
    expect(screen.getAllByText(lookup('engines.evidence.inferred')!).length).toBeGreaterThan(0);
  });
});

describe('key entry appears only where a key is the remaining barrier', () => {
  it('offers no key input on a body whose cells are all closed at the vendor', async () => {
    render(<EnginesContent agent="codex" />);
    await waitFor(() => expect(screen.getByText(lookup('engines.cell.codexKimi')!)).toBeTruthy());
    expect(screen.queryAllByPlaceholderText(lookup('engines.placeholder')!)).toHaveLength(0);
  });

  it('reports the live key state and never claims a connection it cannot know', async () => {
    configuredByProvider = { glm: true, kimi: false };
    render(<EnginesContent agent="claude" />);

    const stored = lookup('engines.status.stored')!;
    const missing = lookup('engines.status.missing')!;
    await waitFor(() => expect(screen.getByText(stored, { exact: false })).toBeTruthy());
    expect(screen.getByText(missing, { exact: false })).toBeTruthy();
    // Only the two engines a key would actually unlock get an input: GLM (runs
    // today) and Kimi (needs a key). DeepSeek is on the row too, but its barrier
    // is an owner decision, not a key — so it offers none.
    expect(screen.getAllByPlaceholderText(/key/i)).toHaveLength(2);
    // "A key is stored" is the only claim the key store can back. Anything that
    // asserts the engine is reachable/authenticated would be the same lie the
    // removed GLM card told.
    expect(screen.queryByText(/^connected$/i)).toBeNull();
  });

  it("saves a key against that engine's own endpoint and reflects it immediately", async () => {
    render(<EnginesContent agent="claude" />);

    const label = interpolate(lookup('engines.inputLabel')!, { provider: 'GLM' });
    const input = await screen.findByLabelText(label);
    fireEvent.change(input, { target: { value: 'sk-fake-key' } });
    fireEvent.click(
      screen.getByRole('button', { name: interpolate(lookup('engines.save')!, { provider: 'GLM' }) }),
    );

    await waitFor(() => {
      const post = fetchCalls.find((c) => (c.init?.method ?? 'GET').toUpperCase() === 'POST');
      expect(post?.url).toBe('/api/providers/glm/api-key');
    });
    await waitFor(() => expect(screen.getByText(lookup('engines.saved')!)).toBeTruthy());
  });

  it('offers removal only once a key is stored', async () => {
    configuredByProvider = { glm: true, kimi: false };
    render(<EnginesContent agent="claude" />);

    const removeGlm = await screen.findByRole('button', {
      name: interpolate(lookup('engines.remove')!, { provider: 'GLM' }),
    });
    // Kimi has no key, so it offers no removal.
    expect(
      screen.queryByRole('button', { name: interpolate(lookup('engines.remove')!, { provider: 'Kimi' }) }),
    ).toBeNull();

    fireEvent.click(removeGlm);
    await waitFor(() => {
      const del = fetchCalls.find((c) => (c.init?.method ?? 'GET').toUpperCase() === 'DELETE');
      expect(del?.url).toBe('/api/providers/glm/api-key');
    });
  });
});
