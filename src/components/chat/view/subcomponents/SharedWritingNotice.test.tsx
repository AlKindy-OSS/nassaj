/**
 * ADR-173 P6 — the notice above the composer in a shared conversation: who holds
 * it (phase-aware), the stuck-stop action, a refused stop, and the fork banner.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const params = Object.entries(options ?? {})
        .filter(([name]) => name !== 'defaultValue')
        .map(([name, value]) => `${name}=${String(value).replace(/[⁨⁩]/g, '')}`);
      return params.length ? `${key}[${params.join(',')}]` : key;
    },
  }),
}));

import SharedWritingNotice from './SharedWritingNotice';

afterEach(cleanup);

const names = (id: number | null) => (id === 1 ? 'ibrahim' : null);

describe('SharedWritingNotice — busy', () => {
  it.each(['running', 'post_result', 'scheduled_wake', 'launching'] as const)('phase %s names the holder', (phase) => {
    render(
      <SharedWritingNotice
        notice={{ kind: 'busy', sessionId: 's', busyBy: 1, phase, stuck: false, canStop: false }}
        resolveName={names}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(`sharedWriting.busy.${phase}[name=ibrahim]`)).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'sharedWriting.stopStuck' })).toBeNull();
  });

  it('falls back to a neutral name when the holder is unknown', () => {
    render(
      <SharedWritingNotice
        notice={{ kind: 'busy', sessionId: 's', busyBy: 9, phase: 'running', stuck: false, canStop: false }}
        resolveName={names}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('sharedWriting.busy.running[name=sharedWriting.someone]')).not.toBeNull();
  });

  it('offers to stop a stuck reply only when the viewer may stop it', () => {
    const onStop = vi.fn();
    const { rerender } = render(
      <SharedWritingNotice
        notice={{ kind: 'busy', sessionId: 's', busyBy: 1, phase: 'running', stuck: true, canStop: false }}
        resolveName={names}
        onStop={onStop}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('sharedWriting.busy.stuck')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'sharedWriting.stopStuck' })).toBeNull();
    rerender(
      <SharedWritingNotice
        notice={{ kind: 'busy', sessionId: 's', busyBy: 1, phase: 'running', stuck: true, canStop: true }}
        resolveName={names}
        onStop={onStop}
        onDismiss={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'sharedWriting.stopStuck' }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});

describe('SharedWritingNotice — stop refused', () => {
  it('explains the refusal with the holder name', () => {
    render(
      <SharedWritingNotice
        notice={{ kind: 'stop_forbidden', sessionId: 's', busyBy: 1, stuck: false }}
        resolveName={names}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('sharedWriting.stopForbidden[name=ibrahim]')).not.toBeNull();
  });
});

describe('SharedWritingNotice — unsupported', () => {
  it('names creator and provider and forks on click', () => {
    const onFork = vi.fn();
    render(
      <SharedWritingNotice
        notice={{ kind: 'unsupported', sessionId: 's', provider: 'codex', creatorName: 'ibrahim', canFork: true }}
        resolveName={names}
        providerName="Codex"
        onFork={onFork}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('sharedWriting.unsupported[creator=ibrahim,provider=Codex]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'sharedWriting.fork' }));
    expect(onFork).toHaveBeenCalledTimes(1);
  });

  it('has no fork action when the provider cannot fork or nothing can be forked', () => {
    render(
      <SharedWritingNotice
        notice={{ kind: 'unsupported', sessionId: 's', provider: 'opencode', creatorName: null, canFork: false }}
        resolveName={names}
        providerName="OpenCode"
        onFork={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(
      'sharedWriting.unsupportedNoFork[creator=sharedWriting.creatorFallback,provider=OpenCode]',
    )).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'sharedWriting.fork' })).toBeNull();
  });

  it('is dismissible', () => {
    const onDismiss = vi.fn();
    render(
      <SharedWritingNotice
        notice={{ kind: 'stop_forbidden', sessionId: 's', busyBy: 1, stuck: false }}
        resolveName={names}
        onDismiss={onDismiss}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'sharedWriting.dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('SharedWritingNotice — stopped by another member (P8 B4)', () => {
  it('names who stopped the reply, from the frame or the roster', () => {
    const { rerender } = render(
      <SharedWritingNotice
        notice={{ kind: 'stopped_by', sessionId: 's', stoppedBy: 3, stoppedByName: 'sara' }}
        resolveName={names}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('sharedWriting.stoppedBy[name=sara]')).not.toBeNull();
    rerender(
      <SharedWritingNotice
        notice={{ kind: 'stopped_by', sessionId: 's', stoppedBy: 1, stoppedByName: null }}
        resolveName={names}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText('sharedWriting.stoppedBy[name=ibrahim]')).not.toBeNull();
  });
});

describe('SharedWritingNotice — width (P8 cosmetic)', () => {
  it('sits in the composer column (centered, capped like the composer), never edge to edge', () => {
    const { container } = render(
      <SharedWritingNotice
        notice={{ kind: 'busy', sessionId: 's', busyBy: 1, phase: 'running', stuck: false, canStop: false }}
        resolveName={names}
        onDismiss={vi.fn()}
      />,
    );
    const outer = container.firstElementChild as HTMLElement;
    const card = screen.getByRole('status');
    // same gutters as ChatComposer's root (px-2 sm:px-4) and its column (mx-auto max-w-4xl)
    expect(outer.className).toContain('px-2');
    expect(outer.className).toContain('sm:px-4');
    expect(card.className).toContain('mx-auto');
    expect(card.className).toContain('max-w-4xl');
    expect(card.className).not.toMatch(/(^|\s)(ml-|mr-|left-|right-)/);
  });
});
