/**
 * The "Active subscriptions" panel: cards are VENDORS, collapsed by default.
 *
 * What is pinned here is the owner's correction (2026-07-28), not styling:
 *
 *  1. COLLAPSED BY DEFAULT. Five cards printing their cycle, provenance, notes
 *     and breakdown at once fill a ~250px panel and nothing can be compared. A
 *     collapsed card carries name + plan + amount, and the whole header — not a
 *     12px chevron — is the button. Expansion is per card.
 *  2. NO ANCHOR EDITOR. The billing anchor is detected server-side now; the UI
 *     never writes it. Asserted at the network boundary (no PUT ever leaves)
 *     rather than by the absence of a widget, which any refactor could restore.
 *     The cycle window AND its provenance stay visible inside the body —
 *     ADR-078 requires a derived/unknown anchor to be marked as such.
 *  3. SUBSCRIPTION → HARNESS → MODEL. A vendor reached through one harness
 *     names it once and lists models flat; a vendor reached through several
 *     (GLM via `opencode` and `glm-cli` — measured on this machine) groups by
 *     harness and closes with the subscription total.
 *
 * `t` resolves against the REAL en/settings.json and only falls back to the
 * caller's defaultValue, so a renamed key is visible here instead of shipping
 * an English default into nine locales.
 *
 * RUNNER: vitest (`NODE_ENV=test npx vitest run`) — jsdom.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import enSettings from '../../../i18n/locales/en/settings.json';

// ── i18n against the shipped bundle ──────────────────────────────────────────

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    enSettings as unknown,
  );
  return typeof value === 'string' ? value : undefined;
}

/** The real translation, with i18next-style {{interpolation}}. */
function translate(key: string, options: Record<string, unknown> = {}): string {
  const template = lookup(key) ?? (options.defaultValue as string) ?? key;
  return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    name in options ? String(options[name]) : match,
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => translate(key, options ?? {}),
    i18n: { language: 'en' },
  }),
}));

// ── the network boundary ─────────────────────────────────────────────────────

const authenticatedFetch = vi.fn();
vi.mock('../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const SubscriptionsSection = (await import('./SubscriptionsSection')).default;

// ── Fixture: the four shapes the panel has to survive ────────────────────────
// Noon UTC on the anchors: a midnight fixture flips a day in half the world and
// would pin these assertions to the runner's timezone.

const payload = {
  pricesAsOf: '2026-07-28',
  subscriptions: [
    {
      // One vendor, one harness → no pointless nesting level.
      provider: 'anthropic',
      displayName: 'Claude',
      plan: 'Max',
      anchorDay: 10,
      anchorSource: 'detected' as const,
      anchorEvidence: 'oauthAccount.subscriptionCreatedAt',
      cycleStart: '2026-07-10T12:00:00.000Z',
      cycleEnd: '2026-08-10T12:00:00.000Z',
      available: true,
      metered: false,
      totalUsd: 42.5,
      sessions: 7,
      complete: true,
      unpricedModels: [],
      byHarness: [
        {
          harness: 'claude-code',
          displayName: 'Claude Code',
          totalUsd: 42.5,
          sessions: 7,
          perModel: [
            { model: 'claude-opus-5', costUsd: 40, requests: 120, sessions: 6 },
            { model: 'claude-sonnet-4-6', costUsd: 2.5, requests: 9, sessions: 1 },
          ],
        },
      ],
    },
    {
      // One vendor, TWO harnesses — the case the old panel got wrong.
      provider: 'glm',
      displayName: 'GLM (z.ai)',
      plan: 'Coding Plan',
      anchorDay: 1,
      anchorSource: 'derived' as const,
      cycleStart: '2026-07-01T12:00:00.000Z',
      cycleEnd: '2026-08-01T12:00:00.000Z',
      available: true,
      metered: false,
      totalUsd: 7,
      sessions: 15,
      complete: false,
      unpricedModels: ['glm-5.2-air'],
      byHarness: [
        {
          harness: 'glm-cli',
          displayName: 'GLM CLI',
          totalUsd: 2,
          sessions: 4,
          perModel: [{ model: 'glm-5.2', costUsd: 2, requests: 12 }],
        },
        {
          harness: 'opencode',
          displayName: 'OpenCode',
          totalUsd: 5,
          sessions: 11,
          perModel: [
            { model: 'glm/glm-5.2', costUsd: 5, requests: 40 },
            { model: 'glm/glm-5.2-air', costUsd: null, requests: 3 },
          ],
        },
      ],
    },
    {
      // Nothing measurable: a reason, never a 0.00.
      provider: 'antigravity',
      displayName: 'Antigravity',
      plan: null,
      anchorDay: 1,
      anchorSource: 'unknown' as const,
      cycleStart: '2026-07-01T12:00:00.000Z',
      cycleEnd: '2026-08-01T12:00:00.000Z',
      available: false,
      reason: 'provider persists no token usage',
      metered: false,
      totalUsd: 0,
      sessions: 3,
      complete: true,
      unpricedModels: [],
    },
    {
      // An older server: no `byHarness` at all.
      provider: 'openai',
      displayName: 'OpenAI',
      plan: 'ChatGPT Plus',
      anchorDay: 22,
      anchorSource: 'manual' as const,
      cycleStart: '2026-07-22T12:00:00.000Z',
      cycleEnd: '2026-08-22T12:00:00.000Z',
      available: true,
      metered: true,
      totalUsd: 1.25,
      sessions: 2,
      complete: true,
      unpricedModels: [],
    },
  ],
};

beforeEach(() => {
  authenticatedFetch.mockReset();
  authenticatedFetch.mockResolvedValue({ ok: true, json: async () => payload });
});

afterEach(cleanup);

/** Bidi isolates are invisible; strip them before comparing rendered text. */
const flat = (text: string | null) => (text ?? '').replace(/[\u2068\u2069]/g, '');

/** Renders and opens the section itself (the fetch is gated on it). */
async function openSection() {
  render(<SubscriptionsSection isOpen />);
  fireEvent.click(
    screen.getByRole('button', { name: translate('subscriptions.title', { defaultValue: 'Active subscriptions' }) }),
  );
  return screen.findByRole('button', { name: /Claude/ });
}

/** The <li> card carrying a given vendor's header button. */
function card(name: RegExp): HTMLElement {
  const header = screen.getByRole('button', { name });
  const li = header.closest('li');
  if (!li) throw new Error(`no card element for ${name}`);
  return li;
}

describe('collapsed by default (owner change 1)', () => {
  it('shows only name, plan and amount before any click', async () => {
    const claude = await openSection();

    expect(claude.getAttribute('aria-expanded')).toBe('false');
    expect(flat(claude.textContent)).toContain('Claude');
    expect(flat(claude.textContent)).toContain('Max');
    expect(flat(claude.textContent)).toContain('$42.50');

    // Everything else waits for the click: cycle, provenance, breakdown.
    const collapsed = flat(card(/Claude/).textContent);
    expect(collapsed).not.toContain(translate('subscriptions.cycleSince', { date: 'July 10' }));
    expect(collapsed).not.toContain(lookup('subscriptions.anchorSource.detected'));
    expect(collapsed).not.toContain('claude-opus-5');
  });

  it('an unavailable card says so without inventing a number', async () => {
    await openSection();
    const antigravity = card(/Antigravity/);

    expect(flat(antigravity.textContent)).toContain(translate('subscriptions.unavailable', { defaultValue: 'Not available' }));
    expect(antigravity.textContent).not.toContain('$0.00');
    // The server's reason is detail, so it lives in the body.
    expect(antigravity.textContent).not.toContain('provider persists no token usage');

    fireEvent.click(within(antigravity).getByRole('button'));
    expect(antigravity.textContent).toContain('provider persists no token usage');
    expect(antigravity.textContent).not.toContain('$0.00');
  });

  it('the whole header is the control, and it is a real button with wired aria', async () => {
    const claude = await openSection();

    expect(claude.tagName).toBe('BUTTON'); // keyboard-reachable by construction
    const bodyId = claude.getAttribute('aria-controls');
    expect(bodyId).toBeTruthy();
    expect(document.getElementById(bodyId as string)).not.toBeNull();

    fireEvent.click(claude);
    expect(claude.getAttribute('aria-expanded')).toBe('true');
    expect(document.getElementById(bodyId as string)?.textContent).toContain('claude-opus-5');
  });

  it('expands per card — opening one leaves the others closed', async () => {
    await openSection();
    fireEvent.click(screen.getByRole('button', { name: /GLM/ }));

    expect(screen.getByRole('button', { name: /GLM/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Claude/ }).getAttribute('aria-expanded')).toBe('false');
    // …and several may be open at once.
    fireEvent.click(screen.getByRole('button', { name: /Claude/ }));
    expect(screen.getByRole('button', { name: /GLM/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: /Claude/ }).getAttribute('aria-expanded')).toBe('true');
  });
});

describe('no anchor editor, but the anchor provenance survives (owner change 2)', () => {
  it('offers no control that could write the cycle day', async () => {
    const claude = await openSection();
    fireEvent.click(claude);
    fireEvent.click(screen.getByRole('button', { name: /GLM/ }));

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();
    // The label of the deleted picker must not survive either. Falls back to
    // the literal string so this still holds once the retired key is dropped
    // from the locale files.
    expect(screen.queryByText(lookup('subscriptions.anchorLabel') ?? 'Cycle start day')).toBeNull();
  });

  it('never sends a write to the server — the PUT route stays unused', async () => {
    const claude = await openSection();
    fireEvent.click(claude);

    expect(authenticatedFetch).toHaveBeenCalledWith('/api/providers/costs/subscriptions');
    for (const [, options] of authenticatedFetch.mock.calls) {
      expect((options as { method?: string } | undefined)?.method).toBeUndefined();
    }
  });

  it('still shows the cycle window and marks a DERIVED anchor as an estimate', async () => {
    await openSection();
    const glm = card(/GLM/);
    fireEvent.click(within(glm).getAllByRole('button')[0]);

    const body = flat(glm.textContent);
    expect(body).toContain(translate('subscriptions.monthToDate', { defaultValue: 'This cycle' }));
    expect(body).toContain(translate('subscriptions.cycleSince', { date: 'July 1' }));
    // ADR-078: an estimated anchor must say it is estimated.
    expect(body).toContain(lookup('subscriptions.anchorSource.derived'));
  });

  it('marks a DETECTED anchor as read from real subscription data', async () => {
    const claude = await openSection();
    fireEvent.click(claude);

    const body = flat(card(/Claude/).textContent);
    expect(body).toContain(translate('subscriptions.cycleSince', { date: 'July 10' }));
    expect(body).toContain(lookup('subscriptions.anchorSource.detected'));
  });
});

describe('subscription → harness → model (owner change 3)', () => {
  it('names the single harness once and lists its models flat', async () => {
    const claude = await openSection();
    fireEvent.click(claude);

    const body = flat(card(/Claude/).textContent);
    expect(body).toContain(translate('subscriptions.viaHarness', { harness: 'Claude Code', defaultValue: 'Via {{harness}}' }));
    expect(body).toContain('claude-opus-5');
    expect(body).toContain('$40.00');
    expect(body).toContain('claude-sonnet-4-6');
    expect(body).toContain('$2.50');
    // One harness ⇒ no restated subscription total: the header already carries
    // it two lines above, and this panel is 250px wide.
    expect(body).not.toContain(translate('subscriptions.subscriptionTotal', { defaultValue: 'Subscription total' }));
  });

  it('groups a vendor used through several harnesses, and closes with its total', async () => {
    await openSection();
    const glm = card(/GLM/);
    fireEvent.click(within(glm).getAllByRole('button')[0]);

    const body = flat(glm.textContent);
    // Each harness names itself and carries its own amount…
    expect(body).toContain('OpenCode');
    expect(body).toContain('$5.00');
    expect(body).toContain('GLM CLI');
    expect(body).toContain('$2.00');
    // …and the subscription total sits at the bottom.
    expect(body).toContain(translate('subscriptions.subscriptionTotal', { defaultValue: 'Subscription total' }));
    expect(body).toContain('$7.00');
    // No "Via X" caption when the grouping is the point.
    expect(body).not.toContain(translate('subscriptions.viaHarness', { harness: 'OpenCode', defaultValue: 'Via {{harness}}' }));
  });

  it('prints the vendor-carrying model id once, not "glm/glm-5.2" inside the GLM card', async () => {
    await openSection();
    const glm = card(/GLM/);
    fireEvent.click(within(glm).getAllByRole('button')[0]);

    expect(flat(glm.textContent)).toContain('glm-5.2');
    expect(flat(glm.textContent)).not.toContain('glm/glm-5.2');
    // The raw id stays reachable for auditing.
    expect(within(glm).getByTitle('glm/glm-5.2')).toBeTruthy();
  });

  it('an unpriced model shows the no-price label and NEVER an amount', async () => {
    await openSection();
    const glm = card(/GLM/);
    fireEvent.click(within(glm).getAllByRole('button')[0]);

    const unpriced = within(glm).getByTitle('glm/glm-5.2-air').closest('li');
    expect(unpriced).not.toBeNull();
    expect(flat(unpriced?.textContent ?? null)).toContain(
      translate('subscriptions.unpricedModel', { defaultValue: 'No official price' }),
    );
    expect(unpriced?.textContent).not.toContain('$');
    // Which is exactly why the card is flagged partial.
    expect(flat(glm.textContent)).toContain(translate('subscriptions.partial', { defaultValue: 'Partial' }));
  });

  it('paints the partial warning amber instead of losing the cascade to a muted base', async () => {
    // `.text-muted-foreground` is emitted AFTER `.text-amber-700` in the built
    // stylesheet, so a note class of "muted + amber" renders GREY however the
    // JSX orders the tokens. Tailwind is not compiled under jsdom, so what is
    // asserted is the contract the component writes: the two never co-occur.
    await openSection();
    const glm = card(/GLM/);
    fireEvent.click(within(glm).getAllByRole('button')[0]);

    const note = within(glm)
      .getAllByText(translate('subscriptions.partial', { defaultValue: 'Partial' }))
      .map((element) => element.closest('p'))
      .find((element): element is HTMLParagraphElement => Boolean(element));

    expect(note).toBeTruthy();
    expect(note?.className).toContain('text-amber-700');
    expect(note?.className).not.toContain('text-muted-foreground');
  });

  it('renders NO breakdown at all when the server sent no byHarness', async () => {
    await openSection();
    const openai = card(/OpenAI/);
    fireEvent.click(within(openai).getAllByRole('button')[0]);

    const body = flat(openai.textContent);
    // The window is still there…
    expect(body).toContain(translate('subscriptions.cycleSince', { date: 'July 22' }));
    // …but nothing pretends to be a breakdown.
    expect(body).not.toContain(translate('subscriptions.subscriptionTotal', { defaultValue: 'Subscription total' }));
    expect(within(openai).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('says which figures are API-equivalent value and which are billed', async () => {
    const claude = await openSection();
    fireEvent.click(claude);
    fireEvent.click(screen.getByRole('button', { name: /OpenAI/ }));

    // A flat-fee plan: the amount is worth-this-much, not owed-this-much.
    expect(flat(card(/Claude/).textContent)).toContain(
      translate('subscriptions.apiEquivalent', { defaultValue: 'API-equivalent value of usage — not money billed' }),
    );
    // metered:true ⇒ the amount really is billed usage.
    expect(flat(card(/OpenAI/).textContent)).toContain(
      translate('subscriptions.billed', { defaultValue: 'Billed usage' }),
    );
  });
});

describe('the section itself', () => {
  it('does not fetch until it is expanded — the server re-reads transcripts to answer', () => {
    render(<SubscriptionsSection isOpen />);
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('stamps the price table once for the whole section', async () => {
    await openSection();
    expect(
      screen.getByText(translate('subscriptions.pricesAsOf', { date: 'Jul 28, 2026' })),
    ).toBeTruthy();
  });
});
