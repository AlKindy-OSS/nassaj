/**
 * The sidebar treatment for a CLOSED conversation.
 *
 * What is defended here is a design decision, not a formatting detail: a closed
 * row is FADED (`text-foreground/70`) and carries a small pill on its metadata
 * line — it is never struck through. `line-through` is painted across the middle
 * of the em box, exactly where Arabic joins its letters and hangs its dots, so
 * it shreds the very titles this sidebar shows most; it also reads
 * "deleted/invalid" for a row that is merely done. Both halves are pinned below:
 * the fade and pill are present, and a strike never is.
 *
 * The fade + pill shipped first and the owner still could not tell a closed row
 * from an open one while scrolling. Two STRUCTURAL markers were added, and the
 * point of the assertions below is that neither can be swallowed by layout:
 * a rail (first flex child of the row) and a check icon placed BEFORE the title
 * inside the title row. jsdom does no layout, so clipping cannot be measured
 * here — what is measured instead is the property that makes clipping
 * impossible: the markers are siblings of the truncating title, never inside
 * it, and never inside the trailing slot that fades away on hover.
 *
 * The other trap this file exists for: SidebarSessionItem renders the row TWICE
 * — a mobile card (`md:hidden`) and a desktop anchor (`hidden md:block`). Treat
 * only one and it looks correct on whichever screen you happened to open. Every
 * visual assertion therefore counts BOTH occurrences.
 *
 * `t` resolves against the REAL en/sidebar.json, so a renamed or missing key
 * fails here instead of shipping an English defaultValue into nine locales.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom, like the two sibling tests in
 * this folder. Tailwind is not compiled in tests, so the assertions are on class
 * tokens (the contract this component actually writes), not computed colour.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { TFunction } from 'i18next';

import enSidebar from '../../../../i18n/locales/en/sidebar.json';
import { createSessionViewModel } from '../../utils/utils';
import type { SessionWithProvider } from '../../types/types';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The row only reads `i18n.language`, and only to hand a locale to the owner
// avatar; `t` itself arrives as a prop, so this stub stays deliberately thin.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'ar' } }),
}));

const SidebarSessionItem = (await import('./SidebarSessionItem')).default;

// ── i18n against the shipped bundle ──────────────────────────────────────────

function lookup(key: string): string | undefined {
  const value = key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    enSidebar as unknown,
  );
  return typeof value === 'string' ? value : undefined;
}

/** The real translation; falls back to the caller's defaultValue only if absent. */
const t = ((key: string, opts?: { defaultValue?: string }) =>
  lookup(key) ?? opts?.defaultValue ?? key) as unknown as TFunction;

const CLOSED_BADGE = lookup('session.closedBadge') as string;
const CLOSED_TITLE = lookup('session.closedTitle') as string;
const CLOSED_ARIA = lookup('session.closedAria') as string;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const project = {
  projectId: 'proj-1',
  displayName: 'nassaj-dev',
  fullPath: '/home/dev/workspace/nassaj',
};

// An Arabic title on purpose: it is the case a strikethrough would have damaged,
// and the case this sidebar shows most.
const ARABIC_TITLE = 'مراجعة تكلفة الجلسات';

// The real failing case: the sidebar is ~250px and titles run long, so the title
// truncates and anything sharing its row competes for what is left.
const LONG_ARABIC_TITLE =
  'مراجعة شاملة لحساب تكلفة المحادثات عبر المزوّدات وإغلاق الجلسة بعد التسوية النهائية';

const NOW = new Date('2026-07-20T13:00:00.000Z');

function makeSession(overrides: Record<string, unknown> = {}): SessionWithProvider {
  return {
    id: 'sess-1',
    summary: ARABIC_TITLE,
    createdAt: '2026-07-20T10:00:00.000Z',
    lastActivity: '2026-07-20T12:00:00.000Z',
    messageCount: 12,
    owner: null,
    __provider: 'claude',
    ...overrides,
  } as SessionWithProvider;
}

/**
 * `narrow` reproduces the owner's sidebar: a 250px, RTL column. jsdom will not
 * compute the overflow, but the wrapper keeps the fixture honest about the case
 * these assertions are written for.
 */
const NarrowSidebar = ({ children }: { children: ReactNode }) => (
  <div dir="rtl" style={{ width: 250 }} data-testid="narrow-sidebar">
    {children}
  </div>
);

function renderRow(
  sessionOverrides: Record<string, unknown> = {},
  opts: { selected?: boolean; narrow?: boolean } = {},
) {
  const session = makeSession(sessionOverrides);
  return render(
    <SidebarSessionItem
      project={project}
      session={session}
      selectedSession={opts.selected ? session : null}
      isStarred={false}
      onToggleStar={() => {}}
      currentTime={NOW}
      editingSession={null}
      editingSessionName=""
      onEditingSessionNameChange={() => {}}
      onStartEditingSession={() => {}}
      onCancelEditingSession={() => {}}
      onSaveEditingSession={() => {}}
      onProjectSelect={() => {}}
      onSessionSelect={() => {}}
      onDeleteSession={() => {}}
      t={t}
    />,
    opts.narrow ? { wrapper: NarrowSidebar } : undefined,
  );
}

/** The two title elements — mobile card first, then the desktop anchor. */
function titleElements(title: string = ARABIC_TITLE): HTMLElement[] {
  const found = screen.getAllByText(title);
  expect(found).toHaveLength(2); // one per responsive branch
  return found;
}

/** The two row-level flex containers: the mobile card's row, then the anchor's. */
function rowContainers(): HTMLElement[] {
  const rows = Array.from(
    document.querySelectorAll<HTMLElement>('.md\\:hidden > div > .flex, .hidden.md\\:block a > .flex'),
  );
  expect(rows).toHaveLength(2);
  return rows;
}

afterEach(() => {
  cleanup();
});

// ── The keys exist ───────────────────────────────────────────────────────────

describe('closed-session i18n', () => {
  it('ships all three keys in en/sidebar.json', () => {
    expect(typeof CLOSED_BADGE).toBe('string');
    expect(typeof CLOSED_TITLE).toBe('string');
    expect(typeof CLOSED_ARIA).toBe('string');
  });
});

// ── Derived state ────────────────────────────────────────────────────────────

describe('isClosed (view model)', () => {
  const vm = (closed: unknown) =>
    createSessionViewModel(makeSession(closed === undefined ? {} : { closed }), NOW, t);

  it('reads a missing flag as open — legacy rows predate the feature', () => {
    expect(vm(undefined).isClosed).toBe(false);
    expect(vm(false).isClosed).toBe(false);
  });

  it('reads SQLite 0/1 the way SQLite means it', () => {
    // better-sqlite3 hands booleans back as integers; a 1 that read as "open"
    // would silently drop the marker from a settled conversation.
    expect(vm(true).isClosed).toBe(true);
    expect(vm(1).isClosed).toBe(true);
    expect(vm(0).isClosed).toBe(false);
  });
});

// ── An open row is untouched ─────────────────────────────────────────────────

describe('an open conversation', () => {
  it('keeps the full-contrast title in both branches', () => {
    renderRow();
    for (const title of titleElements()) {
      expect(title.classList.contains('text-foreground')).toBe(true);
      expect(title.classList.contains('text-foreground/70')).toBe(false);
    }
  });

  it('shows no closed marker at all', () => {
    renderRow();
    expect(screen.queryAllByText(CLOSED_BADGE)).toHaveLength(0);
    expect(screen.queryAllByText(CLOSED_ARIA)).toHaveLength(0);
  });
});

// ── A closed row, in BOTH responsive branches ────────────────────────────────

describe('a closed conversation', () => {
  it('fades the title in the mobile card AND the desktop anchor', () => {
    renderRow({ closed: true, closedAt: '2026-07-20T12:30:00.000Z', closedBy: 2 });

    for (const title of titleElements()) {
      expect(title.classList.contains('text-foreground/70')).toBe(true);
      // Replaced, not stacked: two colour classes would leave the winner to
      // stylesheet order rather than to this component.
      expect(title.classList.contains('text-foreground')).toBe(false);
      // …and the fade did not arrive by dropping the truncation that keeps a
      // long Arabic title from pushing the row's layout around.
      expect(title.classList.contains('truncate')).toBe(true);
      expect(title.getAttribute('dir')).toBe('auto');
    }
  });

  it('marks both branches with the pill: visible word, tooltip, SR phrase', () => {
    renderRow({ closed: true });

    const labels = screen.getAllByText(CLOSED_BADGE);
    expect(labels).toHaveLength(2);

    for (const label of labels) {
      // The short visible word is hidden from AT so the row is announced once,
      // with the fuller phrase instead of a bare "Closed".
      expect(label.getAttribute('aria-hidden')).toBe('true');
      const pill = label.parentElement as HTMLElement;
      expect(pill.getAttribute('title')).toBe(CLOSED_TITLE);
      const srText = pill.querySelector('.sr-only');
      expect(srText?.textContent).toBe(CLOSED_ARIA);
    }
  });

  it('keeps the pill out of the trailing slot that fades on hover', () => {
    renderRow({ closed: true });

    // The desktop trailing slot (fixed w-8, so the title never shifts) fades to
    // opacity-0 on hover; a marker parked there would vanish exactly when the
    // user reaches for the row.
    const slot = document.querySelector('.w-8');
    expect(slot).not.toBeNull();
    expect(slot?.textContent).not.toContain(CLOSED_BADGE);

    for (const label of screen.getAllByText(CLOSED_BADGE)) {
      expect(label.closest('.w-8')).toBeNull();
      expect(label.closest('.group-hover\\:opacity-0')).toBeNull();
    }
  });

  it('stays faded and marked while it is the selected row', () => {
    const { container } = renderRow({ closed: true }, { selected: true });

    // Sanity: the row really is painted in its selected state.
    expect(container.querySelector('.bg-accent')).not.toBeNull();

    for (const title of titleElements()) {
      expect(title.classList.contains('text-foreground/70')).toBe(true);
    }
    expect(screen.getAllByText(CLOSED_BADGE)).toHaveLength(2);
  });
});

// ── The structural markers, in the layout that defeated the pill ─────────────

describe('a closed conversation in a 250px sidebar with a long Arabic title', () => {
  const closedNarrow = () =>
    renderRow({ closed: true, summary: LONG_ARABIC_TITLE }, { narrow: true });

  it('opens the row with a rail in BOTH branches', () => {
    const { container } = closedNarrow();

    const rails = container.querySelectorAll('.w-1.self-stretch');
    expect(rails).toHaveLength(2);

    for (const rail of rails) {
      // Full-opacity muted-foreground: a 60% tint measures 2.21:1 against the
      // light selected row, under the 3:1 floor for a non-text marker.
      expect(rail.classList.contains('bg-muted-foreground')).toBe(true);
      expect(/bg-muted-foreground\//.test(rail.className)).toBe(false);
      // Decorative — the pill already carries the accessible phrase.
      expect(rail.getAttribute('aria-hidden')).toBe('true');
    }
  });

  it('places the rail FIRST in the row, so direction comes from flex order alone', () => {
    // Not a `border-s`: tailwindcss-rtl has been caught setting both physical
    // edges at once. A first flex child mirrors correctly by construction.
    closedNarrow();
    for (const row of rowContainers()) {
      expect(row.firstElementChild?.classList.contains('self-stretch')).toBe(true);
    }
  });

  it('puts the check icon BEFORE the title, outside the box that truncates', () => {
    closedNarrow();

    for (const title of titleElements(LONG_ARABIC_TITLE)) {
      expect(title.classList.contains('truncate')).toBe(true);

      const marker = title.previousElementSibling as HTMLElement | null;
      expect(marker).not.toBeNull();
      expect(marker?.querySelector('svg')).not.toBeNull();
      // `truncate` clips its own box's trailing edge; a sibling that precedes
      // the title is therefore the one thing truncation can never eat.
      expect(title.contains(marker as Node)).toBe(false);
      expect(marker?.classList.contains('flex-shrink-0')).toBe(true);
      // Same contrast floor as the title (≥7.48:1 on every surface), not the
      // muted token that drops to 4.34:1 on a selected light row.
      expect(marker?.classList.contains('text-foreground/70')).toBe(true);
    }
  });

  it('keeps every marker clear of the slot that disappears on hover', () => {
    const { container } = closedNarrow();

    const markers = [
      ...container.querySelectorAll('.w-1.self-stretch'),
      ...screen.getAllByText(CLOSED_BADGE),
      ...titleElements(LONG_ARABIC_TITLE).map((title) => title.previousElementSibling as HTMLElement),
    ];

    for (const marker of markers) {
      // The hover action cluster slides over the trailing area, and the resting
      // w-8 slot fades out under it. A marker in either vanishes exactly when
      // the user reaches for the row.
      expect(marker.closest('.w-8')).toBeNull();
      expect(marker.closest('.group-hover\\:opacity-0')).toBeNull();
    }
  });

  it('shows one check mark per branch, not two', () => {
    const { container } = closedNarrow();

    // The pill lost its icon when the leading marker arrived: two check marks a
    // centimetre apart read as two states rather than one.
    for (const pill of screen.getAllByText(CLOSED_BADGE).map((label) => label.parentElement as HTMLElement)) {
      expect(pill.querySelector('svg')).toBeNull();
    }
    // Provider logo (1) + leading marker (1) per branch = 2 svgs before the
    // action buttons; assert the marker count directly instead.
    const leadMarkers = container.querySelectorAll('.text-foreground\\/70 > svg');
    expect(leadMarkers).toHaveLength(2);
  });

  it('survives the selected state, where the row is painted bg-accent', () => {
    const session = { closed: true, summary: LONG_ARABIC_TITLE };
    const { container } = renderRow(session, { selected: true, narrow: true });

    expect(container.querySelector('.bg-accent')).not.toBeNull();
    expect(container.querySelectorAll('.w-1.self-stretch')).toHaveLength(2);
    expect(screen.getAllByText(CLOSED_BADGE)).toHaveLength(2);
    for (const title of titleElements(LONG_ARABIC_TITLE)) {
      expect(title.classList.contains('text-foreground/70')).toBe(true);
    }
  });

  it('adds none of it to an OPEN row — the rail is the scanning signal', () => {
    const { container } = renderRow({ summary: LONG_ARABIC_TITLE }, { narrow: true });

    expect(container.querySelectorAll('.w-1.self-stretch')).toHaveLength(0);
    expect(container.querySelectorAll('.text-foreground\\/70 > svg')).toHaveLength(0);
    for (const title of titleElements(LONG_ARABIC_TITLE)) {
      expect(title.previousElementSibling).toBeNull();
    }
  });
});

// ── The decision itself ──────────────────────────────────────────────────────

describe('the treatment is a fade, not a strike', () => {
  it('never strikes a closed title through, selected or not', () => {
    for (const selected of [false, true]) {
      const { container } = renderRow({ closed: true }, { selected });
      expect(container.innerHTML).not.toMatch(/line-through|decoration-line/);
      cleanup();
    }
  });

  it('SOURCE GUARD: the strike cannot creep back in through a class name', () => {
    // A strike could also arrive via a utility added later in this file. Keep
    // the ban where the decision lives. Comments are stripped first — the file
    // explains at length WHY it does not strike, and that prose must not be
    // mistaken for the deed.
    const source = readFileSync(resolve(__dirname, 'SidebarSessionItem.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(source).not.toMatch(/line-through|decoration-line/);
  });

  it('fades by colour token, never by row-level opacity', () => {
    renderRow({ closed: true });

    // `opacity-*` on the row would composite the title against whatever sits
    // behind it — the selected/hover background — making contrast unpredictable,
    // and it would drag the action buttons down with it. So no ancestor of a
    // title may carry one.
    for (const title of titleElements()) {
      for (let el: HTMLElement | null = title; el; el = el.parentElement) {
        expect(/(?:^|\s)opacity-\d/.test(el.className)).toBe(false);
      }
    }
  });

  it('dims the decorative provider logo in both branches', () => {
    const { container } = renderRow({ closed: true });

    // Not a contrast concern (it carries no text), and it is what makes the
    // whole row — not just its title — read as quiet at a glance.
    expect(container.querySelectorAll('.opacity-60')).toHaveLength(2);
    cleanup();
    const open = renderRow();
    expect(open.container.querySelectorAll('.opacity-60')).toHaveLength(0);
  });
});
