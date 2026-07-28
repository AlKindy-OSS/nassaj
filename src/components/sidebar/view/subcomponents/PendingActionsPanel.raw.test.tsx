/**
 * PendingActionsPanel.raw.test.tsx — B-247: the red tier reaches the panel, and
 * the execution gate does not move.
 *
 * The defect this covers: two queues asked for the same thing (run something on
 * the server) and only one of them was visible. `pending_server_actions` had a
 * banner, a badge and a panel; `command_board_raw_queue` — the one holding FREE
 * SHELL TEXT — had no notification anywhere and lived at the bottom of a settings
 * card. A `sudo usermod` command sat unseen from 2026-07-26.
 *
 * Raising it into the panel is only safe if raising it changes nothing about how
 * it runs. So these tests are split by what they defend:
 *
 *   VISIBILITY (the feature)
 *     - the red section renders the rows the server handed over, under its own
 *       heading, in its own colour, below the amber list;
 *     - the panel badge counts BOTH queues, because a count that silently omits
 *       the dangerous half is worse than no count.
 *
 *   THE GATE (ADR-070 §16 — qa-critic holds a veto here)
 *     - no control in the red section executes anything: «review» opens
 *       ExecReviewDialog and that is the only door;
 *     - the panel source contains no execute endpoint at all (structural guard —
 *       this one fails if someone later adds a shortcut button);
 *     - the command preview is rendered dir="ltr" with bidi isolation, so the
 *       glance that decides whether to open the reviewer cannot be reordered;
 *     - while the reviewer is open, Escape belongs to the reviewer: the panel
 *       must not tear itself down underneath it (both listen on `document` in
 *       the capture phase, and stopPropagation does not silence a sibling).
 *
 * Visibility itself is NOT re-tested here for a good reason: it is not a client
 * decision. server/routes/system.js ships `commands: []` to anyone who fails
 * mayReadQueue, so "who sees the red section" is covered by the server tests. A
 * client-side role check would be a second, divergible copy of that gate.
 *
 * `t` resolves against the REAL en JSON, so a missing key fails here rather than
 * rendering an English defaultValue in all nine locales.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import enSettings from '../../../../i18n/locales/en/settings.json';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── i18n: resolve against the real bundles, per namespace ────────────────────

function lookup(bundle: unknown, key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    bundle,
  );
  return typeof value === 'string' ? value : undefined;
}

function interpolate(template: string, opts?: Record<string, unknown>): string {
  if (!opts) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    opts[name] === undefined ? whole : String(opts[name]),
  );
}

vi.mock('react-i18next', () => ({
  useTranslation: (ns?: string) => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const bundle = ns === 'settings' ? enSettings : enSidebar;
      return interpolate(
        lookup(bundle, key) ?? (opts?.defaultValue as string) ?? key,
        opts,
      );
    },
    i18n: { language: 'en' },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));

// ── Collaborators ────────────────────────────────────────────────────────────

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({
  useNavigate: () => navigate,
}));

let currentRole = 'owner';
vi.mock('../../../auth/context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 1, username: 'owner', role: currentRole } }),
}));

/**
 * Frozen identity on purpose. The panel resets its per-item state in an effect
 * keyed on `reset`, so a mock that hands back a fresh function each render would
 * loop forever — and the real useRestartWatch does memoise both callbacks.
 */
const restartWatch = {
  isRestarting: false,
  isSuccess: false,
  startPolling: vi.fn(),
  reset: vi.fn(),
};
vi.mock('../../../../hooks/useRestartWatch', () => ({
  useRestartWatch: () => restartWatch,
}));

/**
 * One mock for src/utils/api — the panel and ExecReviewDialog import the same
 * resolved module, so every network call either component makes lands here and
 * can be counted.
 */
const authenticatedFetch = vi.fn();
vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: (...args: unknown[]) => authenticatedFetch(...args),
}));

const PendingActionsPanel = (await import('./PendingActionsPanel')).default;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RAW_ROW = {
  id: 'raw-1',
  // The real stuck command from the incident, shortened.
  command: 'sudo usermod -aG docker jazari',
  digest: 'a'.repeat(64),
  requestedBy: 'jazari',
  requestedAt: '2026-07-26T09:15:00.000Z',
};

const RAW_ROW_2 = {
  id: 'raw-2',
  command: 'rm -rf /tmp/scratch',
  digest: 'b'.repeat(64),
  requestedBy: null,
  requestedAt: null,
};

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    isOpen: true,
    onClose: vi.fn(),
    restartRequired: false,
    actions: [],
    loading: false,
    execute: vi.fn(),
    dismiss: vi.fn(),
    rawCommands: [RAW_ROW],
    onRawQueueChange: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  currentRole = 'owner';
  navigate.mockReset();
  authenticatedFetch.mockReset();
  authenticatedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
});

afterEach(() => {
  cleanup();
});

// ── VISIBILITY ───────────────────────────────────────────────────────────────

describe('B-247 — the raw queue is visible in the panel', () => {
  it('renders a red section with one row per raw command', () => {
    render(<PendingActionsPanel {...baseProps({ rawCommands: [RAW_ROW, RAW_ROW_2] })} />);

    expect(screen.getByText(enSidebar.pendingActions.rawTitle)).toBeTruthy();
    expect(screen.getByText(RAW_ROW.command)).toBeTruthy();
    expect(screen.getByText(RAW_ROW_2.command)).toBeTruthy();
  });

  it('names who queued the command, so a poisoned row is attributable', () => {
    render(<PendingActionsPanel {...baseProps()} />);
    const attribution = interpolate(enSidebar.pendingActions.rawRequestedBy, { name: 'jazari' });
    expect(screen.getByText(attribution)).toBeTruthy();
  });

  it('renders nothing red when the server handed over no rows', () => {
    render(<PendingActionsPanel {...baseProps({ rawCommands: [] })} />);
    expect(screen.queryByText(enSidebar.pendingActions.rawTitle)).toBeNull();
    // With both queues empty the panel still says so rather than looking broken.
    expect(screen.getByText(enSidebar.pendingActions.empty)).toBeTruthy();
  });

  it('counts BOTH queues in the header badge', () => {
    const actions = [
      {
        id: 'act-1',
        actionType: 'safe-restart',
        label: 'Restart',
        commandPreview: null,
        reason: null,
        sessionId: null,
        status: 'pending' as const,
        error: null,
        requestedAt: '2026-07-28T00:00:00.000Z',
      },
    ];
    render(
      <PendingActionsPanel
        {...baseProps({ restartRequired: true, actions, rawCommands: [RAW_ROW, RAW_ROW_2] })}
      />,
    );

    // 1 restartRequired + 1 server action + 2 raw commands.
    expect(screen.getByText('4')).toBeTruthy();
  });
});

// ── THE GATE ─────────────────────────────────────────────────────────────────

describe('B-247 — surfacing the queue does not move the execution gate', () => {
  it('offers no control that runs a raw command directly', () => {
    render(<PendingActionsPanel {...baseProps()} />);

    // The amber tier's «Execute» label must not appear for a raw row. The raw
    // row exposes «review» (opens the dialog) and «dismiss» (deletes bytes).
    const buttons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    const rawRowButtons = buttons.filter((label) => label.includes(RAW_ROW.command.slice(0, 40)));

    expect(rawRowButtons.length).toBe(2);
    expect(rawRowButtons.some((l) => l.startsWith(enSidebar.pendingActions.rawReview))).toBe(true);
    expect(rawRowButtons.some((l) => l.startsWith(enSidebar.pendingActions.dismiss))).toBe(true);
    expect(rawRowButtons.some((l) => l.startsWith(enSidebar.pendingActions.execute))).toBe(false);
  });

  it('fires no request when the review button is pressed — it only opens the dialog', async () => {
    render(<PendingActionsPanel {...baseProps()} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(`^${enSidebar.pendingActions.rawReview}`),
      }),
    );

    await waitFor(() => {
      // The reviewer's own gate is on screen: the per-command acknowledgment.
      expect(screen.getByText(enSettings.commandBoardSettings.rawExec.dialog.ackLabel)).toBeTruthy();
    });
    // Opening a review is a read-only act.
    expect(authenticatedFetch).not.toHaveBeenCalled();
  });

  it('opens the reviewer with its acknowledgment unchecked and its warning shown', async () => {
    render(<PendingActionsPanel {...baseProps()} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(`^${enSidebar.pendingActions.rawReview}`),
      }),
    );

    const checkbox = await screen.findByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    // The reviewer names WHERE the bytes run — a command meant for another host
    // must not be executed here by accident.
    expect(
      screen.getAllByText(enSettings.commandBoardSettings.rawExec.dialog.executionTarget).length,
    ).toBeGreaterThan(0);
  });

  it('renders the command preview LTR with bidi isolation', () => {
    render(<PendingActionsPanel {...baseProps()} />);

    const preview = screen.getByText(RAW_ROW.command);
    expect(preview.getAttribute('dir')).toBe('ltr');
    expect(preview.style.unicodeBidi).toBe('isolate');
  });

  it('SOURCE GUARD: the panel contains no raw-execute endpoint of its own', () => {
    const source = readFileSync(resolve(__dirname, 'PendingActionsPanel.tsx'), 'utf8');

    // The dialog owns POST /command-board-raw/:id/execute. If this ever appears
    // in the panel, someone added a shortcut past the digest + acknowledgment.
    expect(source).not.toMatch(/command-board-raw[^\n]*execute/);
    expect(source).not.toMatch(/confirmationDigest/);
    // And the reviewer is still the component being opened.
    expect(source).toMatch(/ExecReviewDialog/);
  });

  it('leaves Escape to the reviewer while a command is under review', async () => {
    const onClose = vi.fn();
    render(<PendingActionsPanel {...baseProps({ onClose })} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(`^${enSidebar.pendingActions.rawReview}`),
      }),
    );
    await screen.findByRole('checkbox');

    fireEvent.keyDown(document, { key: 'Escape' });

    // The panel stays: closing it would yank the reviewed command off-screen
    // mid-review, and both components listen on `document` in the capture phase.
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on Escape when no command is under review', () => {
    const onClose = vi.fn();
    render(<PendingActionsPanel {...baseProps({ onClose })} />);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});

// ── DISMISS ──────────────────────────────────────────────────────────────────

// ── ONE WAITING ROOM (T-1036) ─────────────────────────────────────────────────
//
// The owner's call after B-247 landed: queued commands belong in the main UI,
// not in settings. That is not a cosmetic preference — two views of one queue is
// what let a command sit unseen for two days, because each list could look
// settled while the other was not. Settings keeps arming, roles and enqueuing;
// it renders no rows and no execution control at all.
//
// Source guards rather than renders: CommandBoardSettingsTab is a 1.5k-line
// screen whose queue card only appears behind an armed flag and a raw tier, so a
// render-based assertion could pass simply because the card never mounted — it
// would prove nothing about the case that matters.

describe('T-1036 — a queued command waits in exactly one place', () => {
  const settingsTab = readFileSync(
    resolve(__dirname, '../../../settings/view/tabs/CommandBoardSettingsTab.tsx'),
    'utf8',
  );
  const panel = readFileSync(resolve(__dirname, 'PendingActionsPanel.tsx'), 'utf8');

  it('the settings tab mounts no review dialog', () => {
    // A type-only import may remain (RawData still describes the payload); what
    // must not exist is the element.
    expect(settingsTab).not.toMatch(/<ExecReviewDialog/);
  });

  it('the settings tab renders no raw command rows', () => {
    // Scoped to `rawData.commands` on purpose: the same file still lists the
    // owner's CUSTOM commands (symbolic, allow-listed, never free shell text),
    // and that list is not what T-1036 moved.
    expect(settingsTab).not.toMatch(/rawData\.commands\.map\(/);
    // The raw payload may still be counted (capacity, "N waiting elsewhere").
    expect(settingsTab).toMatch(/rawData\.commands\.length/);
  });

  it('the settings tab offers no dismiss or execute control for a queued row', () => {
    expect(settingsTab).not.toMatch(/setExecTarget/);
    expect(settingsTab).not.toMatch(/handleDismiss/);
  });

  it('the panel is the one place that mounts the reviewer', () => {
    expect(panel).toMatch(/<ExecReviewDialog/);
  });
});

describe('B-247 — dismissing a raw row', () => {
  it('deletes the row without running it and asks the parent to re-read', async () => {
    const onRawQueueChange = vi.fn();
    render(<PendingActionsPanel {...baseProps({ onRawQueueChange })} />);

    fireEvent.click(
      screen.getByRole('button', {
        name: new RegExp(`^${enSidebar.pendingActions.dismiss}`),
      }),
    );

    await waitFor(() => expect(authenticatedFetch).toHaveBeenCalled());

    const [url, opts] = authenticatedFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/system/command-board-raw/raw-1');
    expect(opts.method).toBe('DELETE');

    await waitFor(() => expect(onRawQueueChange).toHaveBeenCalled());
  });
});
