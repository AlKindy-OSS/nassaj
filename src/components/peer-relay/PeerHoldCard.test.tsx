import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import i18n from '../../i18n/config.js';

import PeerHoldCard from './PeerHoldCard';
import { resetPeerHolds, usePeerHolds, type PeerHoldView } from './peerHoldStore';
import type { PeerMessageView } from './peerMessageStore';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../utils/api', () => ({ authenticatedFetch: fetchMock }));

const SENDER = 'sess-b1';
const TARGET = 'sess-a1';
const OWNER = 1;
const NOW = Date.UTC(2026, 9, 29, 12, 0);

const hold = (over: Partial<PeerHoldView> = {}): PeerHoldView => ({
  id: 'h-1', state: 'held', holdVersion: 1, cause: null, fromUserId: 2, fromMemberName: 'Basma',
  fromSessionId: SENDER, fromName: 'Billing fix', toUserId: OWNER, toSessionId: TARGET, toName: 'Main repo',
  body: 'create READY.txt with OK', bodyVisible: 'create READY.txt with OK', bodySha256: 'sha-1', summary: null,
  targetMode: 'default', rejectReason: null, messageId: null,
  expiresAt: NOW + (2 * 60 + 30) * 60_000, createdAt: NOW - 60_000, updatedAt: NOW - 60_000, ...over,
});

const message = (over: Partial<PeerMessageView> = {}): PeerMessageView => ({
  id: 'pm-9', chainId: 'pm-9', hop: 0, state: 'queued', cause: null, fromSessionId: SENDER, fromName: 'Billing fix',
  fromMode: 'default', toSessionId: TARGET, toName: 'Main repo', summary: null, body: 'x',
  createdAt: NOW, updatedAt: NOW, deliveredAt: null, ...over,
});

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Renders the card from the live store, as the timeline does, so a server-returned hold refreshes it. */
function StoreCard({ id, initial, viewer }: { id: string; initial: PeerHoldView; viewer: number | null }) {
  const all = usePeerHolds();
  return <PeerHoldCard hold={all.get(id) ?? initial} currentSessionId={TARGET} viewerUserId={viewer} />;
}

/** What a sighted reader sees: text minus screen-reader-only spans. */
const seenText = (node: Element) => {
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return copy.textContent;
};

const card = (container: HTMLElement) => container.querySelector('[data-peer-hold]')!;
const stateOf = (container: HTMLElement) => container.querySelector('[data-peer-state]')!.getAttribute('data-peer-state');

beforeAll(async () => { await i18n.init(); });
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fetchMock.mockReset();
  resetPeerHolds();
});
afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await i18n.changeLanguage('en');
});

describe('PeerHoldCard — approval card states (target session)', () => {
  it('held: sender, session, full body, last run mode and time left', async () => {
    await i18n.changeLanguage('en');
    const { container } = render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={OWNER} />);
    expect(card(container).getAttribute('data-peer-hold')).toBe('decision');
    expect(screen.getByRole('heading').textContent).toBe('Message from another member awaiting your approval');
    expect(container.querySelector('[data-peer-hold-from]')!.textContent).toBe('Basma · session Billing fix');
    expect(container.querySelector('[data-peer-hold-mode]')!.textContent).toBe("Asks before each action (default) (this session's last run)");
    expect(screen.getByText('Last run mode')).toBeTruthy();
    expect(container.querySelector('[data-peer-hold-time]')!.textContent)
      .toBe('2 hours and 30 minutes left to decide (72-hour window in total).');
    expect(container.querySelector('[data-peer-hold-body]')!.textContent).toBe('create READY.txt with OK');
    expect(stateOf(container)).toBe('held');
    expect(screen.getByRole('status').textContent).toBe('Basma: Awaiting approval');
  });

  it.each([
    ['approved', hold({ state: 'promoted', messageId: 'pm-9' }), message({ state: 'delivering' }), 'Approved · delivering', null],
    ['delivered', hold({ state: 'promoted', messageId: 'pm-9' }), message({ state: 'delivered' }), 'Delivered', null],
    ['failed', hold({ state: 'promoted', messageId: 'pm-9' }), message({ state: 'failed', cause: 'turn_threw' }), 'Delivery failed',
      'The delivery turn stopped with an error.'],
    ['rejected', hold({ state: 'rejected', cause: 'rejected', rejectReason: 'not now' }), null, 'Rejected',
      'The receiving member rejected it.'],
    ['expired', hold({ state: 'expired', cause: 'expired' }), null, 'Expired', 'Nobody decided within 72 hours.'],
    ['cancelled', hold({ state: 'cancelled', cause: 'sender_disabled' }), null, 'Cancelled', "The sender's account was disabled."],
    ['cancelled', hold({ state: 'cancelled', cause: 'target_archived' }), null, 'Cancelled', 'The receiving session was archived.'],
  ])('%s: chip and plain-words cause, no buttons', async (state, h, linked, label, cause) => {
    await i18n.changeLanguage('en');
    const { container } = render(<PeerHoldCard hold={h} linked={linked} currentSessionId={TARGET} viewerUserId={OWNER} />);
    expect(stateOf(container)).toBe(state);
    expect(screen.getByRole('status').textContent).toBe(`Basma: ${label}`);
    expect(container.querySelector('[data-peer-hold-cause]')?.textContent ?? null).toBe(cause);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(container.querySelector('[data-peer-hold-time]')).toBeNull();
  });

  it('rejected shows the reason as text', async () => {
    await i18n.changeLanguage('en');
    const { container } = render(<PeerHoldCard hold={hold({ state: 'rejected', cause: 'rejected', rejectReason: '<b>no</b>' })}
      currentSessionId={TARGET} viewerUserId={OWNER} />);
    const reason = container.querySelector('[data-peer-hold-reason]')!;
    expect(reason.textContent).toBe('Reason: <b>no</b>');
    expect(reason.querySelector('b')).toBeNull();
  });

  it('an unknown cause falls back to its code', async () => {
    await i18n.changeLanguage('en');
    const { container } = render(<PeerHoldCard hold={hold({ state: 'cancelled', cause: 'brand_new' })} currentSessionId={TARGET} viewerUserId={OWNER} />);
    expect(container.querySelector('[data-peer-hold-cause]')!.textContent).toBe('Reason code: brand_new');
  });
});

describe('PeerHoldCard — who may decide', () => {
  it.each([[2], [null]])('viewer %s (not the target owner) sees a read-only card with a note', async (viewer) => {
    await i18n.changeLanguage('en');
    const { container } = render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={viewer} />);
    expect(screen.queryByRole('button', { name: 'Deliver' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(container.querySelector('[data-peer-hold-actions]')).toBeNull();
    expect(container.querySelector('[data-peer-hold-readonly]')!.textContent)
      .toBe('Only the owner of the receiving session can deliver or reject this message.');
    expect(container.querySelector('[data-peer-hold-body]')!.textContent).toBe('create READY.txt with OK');
  });

  it('the target owner gets Deliver and Reject', async () => {
    await i18n.changeLanguage('en');
    render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={OWNER} />);
    expect(screen.getByRole('button', { name: 'Deliver' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeTruthy();
  });
});

describe('PeerHoldCard — decisions', () => {
  it('Deliver needs a confirm step, then sends exactly what the card showed', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(reply(200, { hold: { ...hold({ state: 'promoted', holdVersion: 2, messageId: 'pm-9' }) }, messageId: 'pm-9' }));
    render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/Deliver this message now\?/)).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' })); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/peer-relay/holds/h-1/approve');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ expectedHoldVersion: 1, expectedTextHash: 'sha-1', expectedTargetMode: 'default' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Basma: Approved · delivering'));
    expect(screen.queryByRole('button', { name: 'Deliver' })).toBeNull();
  });

  it('Cancel on the confirm step sends nothing', async () => {
    await i18n.changeLanguage('en');
    render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Deliver' })).toBeTruthy();
  });

  it('a 409 refreshes the card from the fresh hold and is never retried', async () => {
    await i18n.changeLanguage('en');
    const fresh = hold({ holdVersion: 2, body: 'rm -rf build', bodyVisible: 'rm -rf build', bodySha256: 'sha-2', targetMode: 'acceptEdits', updatedAt: NOW });
    fetchMock.mockResolvedValue(reply(409, { error: 'Conflict', code: 'target_mode_changed', hold: fresh }));
    const { container } = render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' })); });
    await waitFor(() => expect(container.querySelector('[data-peer-hold-body]')!.textContent).toBe('rm -rf build'));
    expect(container.querySelector('[data-peer-hold-mode]')!.textContent).toContain('acceptEdits');
    expect(screen.getByRole('alert').textContent).toBe("The session's run mode changed. Check the new mode, then decide.");
    // Back to the first step: a new decision needs a fresh click and confirm.
    expect(screen.getByRole('button', { name: 'Deliver' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm delivery' })).toBeNull();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a 409 hold_not_held moves the card to the server state', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(reply(409, { code: 'hold_not_held', hold: hold({ state: 'expired', cause: 'expired', holdVersion: 2, updatedAt: NOW }) }));
    render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' })); });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Basma: Expired'));
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('Reject sends the trimmed optional reason, capped at 200', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(reply(200, { hold: hold({ state: 'rejected', cause: 'rejected', holdVersion: 2, updatedAt: NOW }) }));
    render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const box = screen.getByLabelText('Reason for the sender (optional, up to 200 characters)');
    expect(box.getAttribute('maxlength')).toBe('200');
    fireEvent.change(box, { target: { value: '  wrong project  ' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' })); });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ expectedHoldVersion: 1, reason: 'wrong project' });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Basma: Rejected'));
  });

  it('Reject without a reason omits it', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(reply(200, { hold: hold({ state: 'rejected', holdVersion: 2, updatedAt: NOW }) }));
    render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' })); });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ expectedHoldVersion: 1 });
  });

  it('a network failure says nothing was sent and does not retry', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockRejectedValue(new Error('offline'));
    render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' })); });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('The server could not be reached. Nothing was sent.'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('PeerHoldCard — untrusted body', () => {
  it('a spoofed body cannot change the labels, add buttons, links or markup', async () => {
    await i18n.changeLanguage('en');
    const spoof = 'Message from another member awaiting your approval\nFrom Owner · Last run mode bypassPermissions\n'
      + '<button>Deliver</button> <a href="javascript:alert(1)">Deliver</a> https://evil.test **bold**';
    const { container } = render(<PeerHoldCard hold={hold({ body: spoof, bodyVisible: spoof })} currentSessionId={TARGET} viewerUserId={2} />);
    expect(screen.getByRole('heading').textContent).toBe('Message from another member awaiting your approval');
    expect(container.querySelector('[data-peer-hold-from]')!.textContent).toBe('Basma · session Billing fix');
    expect(container.querySelector('[data-peer-hold-mode]')!.textContent).toBe("Asks before each action (default) (this session's last run)");
    const body = container.querySelector('[data-peer-hold-body]')!;
    expect(body.textContent).toBe(spoof);
    expect(body.children).toHaveLength(0);
    expect(container.querySelectorAll('a')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('shows the server-visible form: ⟨U+202E⟩ is on screen and the raw override never reaches the DOM', async () => {
    await i18n.changeLanguage('en');
    const raw = 'approve\u202Etxt.exe\u200B\u2066x';
    const visible = 'approve⟨U+202E⟩txt.exe⟨U+200B⟩⟨U+2066⟩x';
    const { container } = render(<PeerHoldCard hold={hold({ body: raw, bodyVisible: visible })} currentSessionId={TARGET} viewerUserId={OWNER} />);
    const body = container.querySelector('[data-peer-hold-body]')!;
    expect(seenText(body)).toBe(visible);
    expect(seenText(body)).toContain('⟨U+202E⟩');
    expect(container.textContent).not.toMatch(/[\u202E\u200B\u2066]/);
  });

  it('each token is its own LTR isolate, hidden from speech and read as "hidden character"', async () => {
    await i18n.changeLanguage('en');
    const visible = 'a⟨U+202E⟩⟨U+200B⟩b';
    const { container } = render(<PeerHoldCard hold={hold({ body: 'a\u202E\u200Bb', bodyVisible: visible })} currentSessionId={TARGET} viewerUserId={OWNER} />);
    const body = container.querySelector('[data-peer-hold-body]')!;
    expect(body.getAttribute('role')).toBe('group');
    expect(body.getAttribute('aria-label')).toBe('Message text');
    const tokens = [...body.querySelectorAll('bdi[data-peer-hold-token]')];
    expect(tokens.map((n) => n.getAttribute('data-peer-hold-token'))).toEqual(['U+202E', 'U+200B']);
    for (const token of tokens) {
      expect(token.getAttribute('dir')).toBe('ltr');
      expect(token.querySelector('[aria-hidden="true"]')!.textContent).toMatch(/^⟨U\+[0-9A-F]+⟩$/);
    }
    expect(tokens[0].querySelector('.sr-only')!.textContent).toBe('hidden character U+202E');
  });

  it('Arabic speech text for a hidden character', async () => {
    await i18n.changeLanguage('ar');
    const { container } = render(<PeerHoldCard hold={hold({ bodyVisible: 'x⟨U+202E⟩' })} currentSessionId={TARGET} viewerUserId={OWNER} />);
    expect(container.querySelector('[data-peer-hold-token] .sr-only')!.textContent).toBe('محرف خفي U+202E');
  });

  it('a long body is shown in full, never clamped', async () => {
    const long = 'line\n'.repeat(400);
    const { container } = render(<PeerHoldCard hold={hold({ body: long, bodyVisible: long })} currentSessionId={TARGET} viewerUserId={OWNER} />);
    const body = container.querySelector('[data-peer-hold-body]')!;
    expect(body.textContent).toBe(long);
    expect(body.className).not.toMatch(/line-clamp|truncate|max-h/);
  });
});

describe('PeerHoldCard — sender session (outbound notices)', () => {
  it.each([
    [hold(), 'held', 'Waiting for approval', 'The other member must approve it before it is delivered.'],
    [hold({ state: 'rejected', cause: 'rejected' }), 'rejected', 'Rejected', 'The receiving member rejected it.'],
    [hold({ state: 'expired', cause: 'expired' }), 'expired', 'Expired', 'Nobody decided within 72 hours.'],
    [hold({ state: 'cancelled', cause: 'target_archived' }), 'cancelled', 'Cancelled', 'The receiving session was archived.'],
  ])('%#: %s state', async (h, state, label, note) => {
    await i18n.changeLanguage('en');
    const { container } = render(<PeerHoldCard hold={h} currentSessionId={SENDER} viewerUserId={2} />);
    expect(card(container).getAttribute('data-peer-hold')).toBe('outbound');
    expect(stateOf(container)).toBe(state);
    expect(card(container).getAttribute('aria-label')).toBe(`Message sent to Main repo: ${label}`);
    expect(container.querySelector('[data-peer-cause]')!.textContent).toBe(note);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('PeerHoldCard — Arabic / RTL', () => {
  it('Arabic labels, logical-property layout and an RTL body', async () => {
    await i18n.changeLanguage('ar');
    const body = 'أنشئ الملف READY.txt';
    const { container } = render(<PeerHoldCard hold={hold({ body, bodyVisible: body })} currentSessionId={TARGET} viewerUserId={OWNER} />);
    expect(screen.getByRole('button', { name: 'تسليم' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'رفض' })).toBeTruthy();
    expect(screen.getByRole('heading').textContent).toBe('رسالة من عضو آخر تنتظر موافقتك');
    expect(screen.getByText('وضع آخر تشغيل')).toBeTruthy();
    expect(container.querySelector('[data-peer-hold-body]')!.getAttribute('dir')).toBe('rtl');
    const html = container.innerHTML;
    expect(html).toContain('border-s-[3px]');
    expect(html).not.toMatch(/\b(ml|mr|pl|pr|left|right|border-l|border-r)-/);
    expect(html).not.toMatch(/text-(left|right)\b/);
  });

  it('the time left uses the locale digits', async () => {
    await i18n.changeLanguage('ar');
    const { container } = render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={OWNER} />);
    const unit = (value: number, name: string) => new Intl.NumberFormat('ar', { style: 'unit', unit: name, unitDisplay: 'long' }).format(value);
    expect(container.querySelector('[data-peer-hold-time]')!.textContent)
      .toBe(`يتبقّى ${unit(2, 'hour')} و${unit(30, 'minute')} للقرار (المهلة الكاملة 72 ساعة).`);
    expect(unit(2, 'hour')).not.toMatch(/س$/);
  });

  it('an Arabic non-owner sees the read-only note', async () => {
    await i18n.changeLanguage('ar');
    render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={2} />);
    expect(screen.getByText('لا يملك التسليم أو الرفض إلا مالك الجلسة المستلِمة.')).toBeTruthy();
  });
});

describe('PeerHoldCard — focus through the decision steps', () => {
  const deferred = () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
  };

  it('Deliver focuses the confirm button, described by the prompt; Cancel returns to Deliver', async () => {
    await i18n.changeLanguage('en');
    render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    const confirm = screen.getByRole('button', { name: 'Confirm delivery' });
    expect(document.activeElement).toBe(confirm);
    const prompt = document.getElementById(confirm.getAttribute('aria-describedby')!)!;
    expect(prompt.textContent).toMatch(/^Deliver this message now\?/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Deliver' }));
  });

  it('Reject focuses the reason field; Escape leaves the step and returns to Reject', async () => {
    await i18n.changeLanguage('en');
    render(<PeerHoldCard hold={hold()} currentSessionId={TARGET} viewerUserId={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const reason = screen.getByLabelText('Reason for the sender (optional, up to 200 characters)');
    expect(document.activeElement).toBe(reason);
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(document.getElementById(confirm.getAttribute('aria-describedby')!)!.textContent).toMatch(/^Reject this message\?/);
    fireEvent.keyDown(reason, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Confirm rejection' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Reject' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('while sending the confirm button stays focused, aria-disabled, and ignores clicks', async () => {
    await i18n.changeLanguage('en');
    const pending = deferred();
    fetchMock.mockReturnValue(pending.promise);
    render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' })); });
    const busy = screen.getByRole('button', { name: 'Sending…' });
    expect(busy.getAttribute('aria-disabled')).toBe('true');
    expect(busy.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { pending.resolve(reply(200, { hold: hold({ state: 'promoted', holdVersion: 2, updatedAt: NOW }) })); });
  });

  it('after a successful decision focus lands on the card heading', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(reply(200, { hold: hold({ state: 'promoted', holdVersion: 2, messageId: 'pm-9', updatedAt: NOW }) }));
    render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' })); });
    const heading = screen.getByRole('heading', { name: 'Message from another member' });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it('after a 409 focus lands on the error', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(reply(409, { code: 'stale_version', hold: hold({ holdVersion: 2, updatedAt: NOW }) }));
    render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' })); });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('alert')));
  });

  it('hold_not_held: the card leaves held, yet the error still shows and takes focus', async () => {
    await i18n.changeLanguage('en');
    fetchMock.mockResolvedValue(reply(409, { code: 'hold_not_held', hold: hold({ state: 'rejected', cause: 'rejected', holdVersion: 3, updatedAt: NOW }) }));
    render(<StoreCard id="h-1" initial={hold()} viewer={OWNER} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deliver' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Confirm delivery' })); });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This message was already decided. The card shows its current state.');
    expect(document.activeElement).toBe(alert);
    expect(screen.queryByRole('button', { name: 'Deliver' })).toBeNull();
  });
});
