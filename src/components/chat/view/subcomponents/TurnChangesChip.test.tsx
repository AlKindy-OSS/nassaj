// @vitest-environment jsdom
/**
 * T-2095: the per-turn "files changed" chip under an agent reply. Runs a real
 * i18next instance so Arabic plural categories and both locales are exercised.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import chatAr from '../../../../i18n/locales/ar/chat.json';
import chatEn from '../../../../i18n/locales/en/chat.json';
import type { TurnCheckpointEvent } from '../../types/types';

import TurnChangesChip from './TurnChangesChip';

function i18nFor(lng: 'ar' | 'en') {
  const i18n = createInstance();
  void i18n.use(initReactI18next).init({
    lng,
    fallbackLng: 'en',
    resources: { ar: { chat: chatAr }, en: { chat: chatEn } },
    interpolation: { escapeValue: false },
  });
  return i18n;
}

function event(overrides: Partial<TurnCheckpointEvent> = {}): TurnCheckpointEvent {
  return {
    turnSeq: 4,
    status: 'captured',
    counts: { added: 1, modified: 2, deleted: 0 },
    withheldCount: 0,
    ...overrides,
  };
}

function renderChip(checkpoint: TurnCheckpointEvent | null, lng: 'ar' | 'en' = 'en', onOpen = vi.fn()) {
  const view = render(
    <I18nextProvider i18n={i18nFor(lng)}>
      <TurnChangesChip checkpoint={checkpoint} onOpen={onOpen} />
    </I18nextProvider>,
  );
  return { ...view, onOpen };
}

afterEach(cleanup);

describe('TurnChangesChip', () => {
  it('renders nothing without a checkpoint event (non-owners never receive one)', () => {
    const { container } = renderChip(null);
    expect(container.innerHTML).toBe('');
  });

  it('is a real button naming the change count and opens that turn', () => {
    const { onOpen } = renderChip(event());
    const button = screen.getByRole('button', { name: /3 files changed/ });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toContain('3 files changed');
    expect(button.className).toContain('h-7');
    expect(button.className).toContain('focus-visible:ring-2');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledWith(4);
  });

  it('appends the withheld count in the warning tone, with words not colour alone', () => {
    renderChip(event({ withheldCount: 2 }));
    const withheld = screen.getByText('(2 withheld)');
    expect(withheld.className).toContain('text-warning');
    expect(screen.getByRole('button').getAttribute('aria-label')).toMatch(/2 withheld/);
  });

  it('shows plain text, not a button, when the turn changed no file', () => {
    renderChip(event({ counts: { added: 0, modified: 0, deleted: 0 } }));
    expect(screen.getByText('No file changes')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps a button when only withheld paths changed, so they can be inspected', () => {
    renderChip(event({ counts: { added: 0, modified: 0, deleted: 0 }, withheldCount: 1 }));
    expect(screen.getByRole('button').textContent).toContain('(1 withheld)');
  });

  it('announces tracking politely while the turn runs', () => {
    const { container } = renderChip(event({ status: 'running' }));
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('Tracking changes…');
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
  });

  it('shows a skipped turn as a quiet line with its reason and no icon', () => {
    const { container } = renderChip(event({ status: 'skipped', reason: 'not_owner' }));
    expect(screen.getByText('Change tracking unavailable: owner only')).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['not_overlay', 'Change tracking unavailable: shared workspace'],
    ['no_principal', 'Change tracking unavailable: no signed-in owner'],
    ['low_disk', 'Change tracking unavailable: low disk space'],
    ['timeout', 'Change tracking timed out'],
  ])('names the %s skip reason', (reason, text) => {
    renderChip(event({ status: 'skipped', reason }));
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('shows a failed capture with a warning icon', () => {
    const { container } = renderChip(event({ status: 'failed', reason: 'capture_failed' }));
    expect(screen.getByText("Could not record this turn's changes")).toBeTruthy();
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('text-warning');
  });

  it.each([
    [1, 'تغيّر ملف واحد'],
    [2, 'تغيّر ملفان'],
    [3, 'تغيّرت 3 ملفات'],
    [11, 'تغيّر 11 ملفًا'],
    [100, 'تغيّر 100 ملف'],
  ])('uses the Arabic plural category for %i files', (count, text) => {
    renderChip(event({ counts: { added: count, modified: 0, deleted: 0 } }), 'ar');
    expect(screen.getByRole('button').textContent).toContain(text);
  });

  it('localizes withheld and skipped lines in Arabic', () => {
    renderChip(event({ withheldCount: 2 }), 'ar');
    expect(screen.getByText('(2 محجوب)')).toBeTruthy();
    cleanup();
    renderChip(event({ status: 'skipped', reason: 'low_disk' }), 'ar');
    expect(screen.getByText('تتبّع التغييرات متوقف: مساحة القرص منخفضة')).toBeTruthy();
  });
});
