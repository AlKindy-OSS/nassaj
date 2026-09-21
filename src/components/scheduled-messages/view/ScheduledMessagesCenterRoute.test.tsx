import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setPageBaseTitle, setTitleOutcome } from '../../../utils/pageTitleNotification';
import { useAllScheduledMessages } from '../hooks/useAllScheduledMessages';

import ScheduledMessagesCenterRoute from './ScheduledMessagesCenterRoute';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('../hooks/useAllScheduledMessages', () => ({ useAllScheduledMessages: vi.fn() }));

describe('ScheduledMessagesCenterRoute', () => {
  beforeEach(() => {
    vi.mocked(useAllScheduledMessages).mockReturnValue({ messages: [], loading: false, loadingMore: false, pages: { pending: { total: 0, hasMore: false, nextOffset: null }, running: { total: 0, hasMore: false, nextOffset: null }, failed: { total: 0, hasMore: false, nextOffset: null } }, total: 0, hasMore: false, busyIds: new Set(), error: null, errorKind: null, stale: false, refresh: vi.fn(), loadMore: vi.fn(), update: vi.fn(), cancel: vi.fn() });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; });
    setTitleOutcome(null);
    setPageBaseTitle('Previous');
  });
  afterEach(() => { cleanup(); setTitleOutcome(null); vi.unstubAllGlobals(); });

  it('announces the route through title and heading focus', () => {
    const { unmount } = render(<ScheduledMessagesCenterRoute projects={[]} onOpenSession={() => undefined} />);
    expect(document.title).toContain('scheduled.center.title');
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    unmount();
    expect(document.title).toBe('Previous');
  });

  it('keeps the latest completion marker when mounting and leaving the route', () => {
    setTitleOutcome('done');
    const { unmount } = render(<ScheduledMessagesCenterRoute projects={[]} onOpenSession={() => undefined} />);
    expect(document.title).toBe('[Done] scheduled.center.title — Nassaj');
    setTitleOutcome('error');
    unmount();
    expect(document.title).toBe('[Error] Previous');
  });

  it('does not restore a completion marker that was acknowledged while the route was open', () => {
    setTitleOutcome('done');
    const { unmount } = render(<ScheduledMessagesCenterRoute projects={[]} onOpenSession={() => undefined} />);
    setTitleOutcome(null);
    unmount();
    expect(document.title).toBe('Previous');
  });
});
