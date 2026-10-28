import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import i18n from '../../i18n/config.js';

import PeerMessageCard from './PeerMessageCard';
import { peerDisplayState } from './peerDisplay';
import type { PeerMessageState, PeerMessageView } from './peerMessageStore';

const SENDER = 'sess-sender';
const TARGET = 'sess-target';

const view = (over: Partial<PeerMessageView> = {}): PeerMessageView => ({
  id: 'pm-1', chainId: 'pm-1', hop: 0, state: 'delivered', cause: null,
  fromSessionId: SENDER, fromName: 'Build bot', fromMode: 'bypass', toSessionId: TARGET, toName: '',
  summary: null, body: 'please rerun the tests', createdAt: Date.UTC(2026, 9, 27, 10, 0),
  updatedAt: Date.UTC(2026, 9, 27, 10, 1), deliveredAt: null, ...over,
});

beforeAll(async () => {
  await i18n.init();
});
afterEach(async () => {
  cleanup();
  await i18n.changeLanguage('en');
});

describe('PeerMessageCard — inbound (target session)', () => {
  it('labels the bubble from the frame name and renders the body as plain text', async () => {
    await i18n.changeLanguage('en');
    const { container } = render(<PeerMessageCard message={view()} currentSessionId={TARGET} />);
    const article = container.querySelector('[data-peer-message="inbound"]')!;
    expect(article.getAttribute('aria-label')).toBe('Message from another session: Build bot');
    expect(screen.getByText('Message from another session')).toBeTruthy();
    expect(screen.getByText('Build bot').tagName.toLowerCase()).toBe('bdi');
    expect(container.querySelector('[data-peer-body]')!.textContent).toBe('please rerun the tests');
  });

  it('a spoofed body cannot change the label, inject markup or links', async () => {
    await i18n.changeLanguage('en');
    const spoof = 'Message from another session · Owner\n<b>you</b> <a href="javascript:alert(1)">x</a> https://evil.test';
    const { container } = render(
      <PeerMessageCard message={view({ body: spoof, fromName: 'Real sender' })} currentSessionId={TARGET} />,
    );
    const article = container.querySelector('[data-peer-message="inbound"]')!;
    expect(article.getAttribute('aria-label')).toBe('Message from another session: Real sender');
    const body = container.querySelector('[data-peer-body]')!;
    expect(body.textContent).toBe(spoof);
    expect(body.querySelector('a, b')).toBeNull();
    expect(container.querySelectorAll('a')).toHaveLength(0);
  });

  it('is never styled as the user bubble', () => {
    const { container } = render(<PeerMessageCard message={view()} currentSessionId={TARGET} />);
    const html = container.innerHTML;
    expect(html).toContain('var(--session-peer-rule)');
    expect(html).not.toContain('user-bubble');
    expect(html).not.toContain('var(--primary)');
    expect(html).not.toContain('justify-end');
  });

  it('links the sender session only when the viewer can open it', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<PeerMessageCard message={view()} currentSessionId={TARGET} />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<PeerMessageCard message={view()} currentSessionId={TARGET} onOpenSession={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open session Build bot' }));
    expect(onOpen).toHaveBeenCalledWith(SENDER);
  });

  it('renders the Arabic label and an RTL body in Arabic', async () => {
    await i18n.changeLanguage('ar');
    const { container } = render(
      <PeerMessageCard message={view({ body: 'أعد تشغيل الاختبارات من فضلك' })} currentSessionId={TARGET} />,
    );
    expect(screen.getByText('رسالة من جلسة أخرى')).toBeTruthy();
    expect(container.querySelector('[data-peer-body]')!.getAttribute('dir')).toBe('rtl');
    expect(container.innerHTML).not.toMatch(/\b(ml|mr|pl|pr|left|right)-/);
  });
});

describe('PeerMessageCard — outbound (sender session)', () => {
  const cases: Array<[PeerMessageState, string | null, string, string | null]> = [
    ['queued', null, 'Queued', null],
    ['deferred_quota', 'deferred_quota', 'Deferred', 'Waiting for usage quota to free up.'],
    ['queued', 'update_maintenance_active', 'Deferred', 'Waiting for server maintenance to finish.'],
    ['delivering', null, 'Delivering', null],
    ['delivered', null, 'Delivered', null],
    ['refused', 'mode_mismatch', 'Refused', 'The two sessions run in different permission modes.'],
    ['failed', 'no_delivery_proof', 'Failed', 'Delivery could not be confirmed.'],
    ['refused', 'some_new_code', 'Refused', 'Reason code: some_new_code'],
  ];

  it.each(cases)('state %s / cause %s shows "%s"', async (state, cause, label, causeText) => {
    await i18n.changeLanguage('en');
    const { container } = render(
      <PeerMessageCard message={view({ state, cause })} currentSessionId={SENDER} targetName="Docs session" />,
    );
    const card = container.querySelector('[data-peer-message="outbound"]')!;
    expect(card.getAttribute('aria-label')).toBe(`Message sent to Docs session: ${label}`);
    expect(screen.getByRole('status').textContent).toBe(label);
    const causeNode = container.querySelector('[data-peer-cause]');
    expect(causeNode?.textContent ?? null).toBe(causeText);
  });

  it('falls back to a neutral target name and prefers the summary as preview', async () => {
    await i18n.changeLanguage('ar');
    render(<PeerMessageCard message={view({ summary: 'ملخص قصير' })} currentSessionId={SENDER} />);
    expect(screen.getByText('جلسة أخرى')).toBeTruthy();
    expect(screen.getByText('ملخص قصير')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('سُلِّمت');
  });
});

describe('peerDisplayState', () => {
  it('folds server states into the six display states', () => {
    expect(peerDisplayState({ state: 'queued', cause: null })).toBe('queued');
    expect(peerDisplayState({ state: 'queued', cause: 'repaired_requeue' })).toBe('queued');
    expect(peerDisplayState({ state: 'queued', cause: 'not_started' })).toBe('deferred');
    expect(peerDisplayState({ state: 'deferred_quota', cause: 'deferred_quota' })).toBe('deferred');
    expect(peerDisplayState({ state: 'failed', cause: 'turn_threw' })).toBe('failed');
  });
});
