import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';

import { holdTimeLeft, peerHoldDisplayState } from './peerHoldDisplay';
import {
  applyPeerHold, ingestPeerHoldFrame, parsePeerHoldFrame, parsePeerHoldView, resetPeerHolds,
  selectPeerHoldInbox, selectPeerHoldsForSession, usePeerHolds, type PeerHoldView,
} from './peerHoldStore';
import type { PeerMessageView } from './peerMessageStore';
import { buildPeerEntries } from './usePeerTimeline';

const wire = (over: Record<string, unknown> = {}) => ({
  id: 'h-1', chainId: 'c', state: 'held', holdVersion: 1, holdCauses: 'cross_member', cause: null,
  fromUserId: 2, fromMemberName: 'Basma', fromSessionId: 'b1', fromName: 'B one', fromMode: 'default',
  toUserId: 1, toSessionId: 'a1', toName: 'A one', projectId: null, body: 'hi\u202E', bodyVisible: 'hi⟨U+202E⟩',
  bodySha256: 'sha', bodyBytes: 5, summary: null, hop: 0, targetMode: 'default',
  targetModeLabel: "default (this session's last run)", targetModeShown: null, decidedBy: null, decidedAt: null,
  rejectReason: null, messageId: null, expiresAt: 3_000, createdAt: 1_000, updatedAt: 1_000, ...over,
});
const view = (over: Record<string, unknown> = {}) => parsePeerHoldView(wire(over)) as PeerHoldView;
const stored = (id: string) => renderHook(() => usePeerHolds()).result.current.get(id);

afterEach(() => { cleanup(); resetPeerHolds(); });

describe('parsePeerHoldView', () => {
  it('keeps the server fields the card needs', () => {
    const v = view();
    expect(v).toMatchObject({ id: 'h-1', state: 'held', holdVersion: 1, fromMemberName: 'Basma', bodyVisible: 'hi⟨U+202E⟩', targetMode: 'default' });
  });

  it.each([
    ['missing bodyVisible (fail closed: the raw body is never shown alone)', { bodyVisible: undefined }],
    ['unknown state', { state: 'approved' }],
    ['non-integer version', { holdVersion: '1' }],
    ['missing target owner', { toUserId: null }],
    ['missing body hash', { bodySha256: '' }],
    ['bad expiry', { expiresAt: 'soon' }],
  ])('rejects %s', (_name, over) => {
    expect(parsePeerHoldView(wire(over))).toBeNull();
  });

  it('accepts only version 1 frames of type peer-hold', () => {
    expect(parsePeerHoldFrame({ type: 'peer-hold', version: 1, hold: wire() })?.id).toBe('h-1');
    expect(parsePeerHoldFrame({ type: 'peer-hold', version: 2, hold: wire() })).toBeNull();
    expect(parsePeerHoldFrame({ type: 'peer-message', version: 1, hold: wire() })).toBeNull();
  });
});

describe('store', () => {
  it('ingest claims every peer-hold frame, valid or not, and nothing else', () => {
    expect(ingestPeerHoldFrame({ type: 'peer-hold', version: 9 })).toBe(true);
    expect(ingestPeerHoldFrame({ type: 'peer-message', version: 1 })).toBe(false);
    expect(ingestPeerHoldFrame(null)).toBe(false);
  });

  it('a higher version wins; an older one, or an older update at the same version, is ignored', () => {
    applyPeerHold(view({ holdVersion: 2, state: 'rejected', updatedAt: 2_000 }));
    applyPeerHold(view({ holdVersion: 1, state: 'held', updatedAt: 9_000 }));
    expect(stored('h-1')?.state).toBe('rejected');
    applyPeerHold(view({ holdVersion: 2, state: 'held', updatedAt: 1_500 }));
    expect(stored('h-1')?.state).toBe('rejected');
    expect(ingestPeerHoldFrame({ type: 'peer-hold', version: 1, hold: wire({ holdVersion: 3, state: 'held', cause: 'rehold', updatedAt: 3_000 }) })).toBe(true);
    expect(stored('h-1')).toMatchObject({ state: 'held', holdVersion: 3, cause: 'rehold' });
  });

  it('session selector returns both directions, oldest first', () => {
    applyPeerHold(view({ id: 'late', createdAt: 9 }));
    applyPeerHold(view({ id: 'early', createdAt: 1, fromSessionId: 'a1', toSessionId: 'z' }));
    applyPeerHold(view({ id: 'other', fromSessionId: 'q', toSessionId: 'r' }));
    const all = renderHook(() => usePeerHolds()).result.current;
    expect(selectPeerHoldsForSession(all, 'a1').map((h) => h.id)).toEqual(['early', 'late']);
    expect(selectPeerHoldsForSession(all, null)).toEqual([]);
  });

  it('inbox lists only held rows addressed to the viewer, newest first', () => {
    const all = new Map<string, PeerHoldView>([
      ['a', view({ id: 'a', createdAt: 1 })],
      ['b', view({ id: 'b', createdAt: 2 })],
      ['c', view({ id: 'c', toUserId: 3 })],
      ['d', view({ id: 'd', state: 'expired' })],
    ]);
    expect(selectPeerHoldInbox(all, 1).map((h) => h.id)).toEqual(['b', 'a']);
    expect(selectPeerHoldInbox(all, null)).toEqual([]);
  });
});

describe('display folding', () => {
  const msg = (state: PeerMessageView['state']) => ({ state });
  it.each([
    ['held', null, 'held'],
    ['promoted', null, 'approved'],
    ['promoted', msg('queued'), 'approved'],
    ['promoted', msg('delivering'), 'approved'],
    ['promoted', msg('delivered'), 'delivered'],
    ['promoted', msg('failed'), 'failed'],
    ['promoted', msg('refused'), 'failed'],
    ['rejected', null, 'rejected'],
    ['expired', null, 'expired'],
    ['cancelled', null, 'cancelled'],
  ] as const)('%s + %o → %s', (state, linked, expected) => {
    expect(peerHoldDisplayState({ state }, linked)).toBe(expected);
  });

  it('time left rounds up to the minute and ends at expiry', () => {
    expect(holdTimeLeft(72 * 3_600_000, 0)).toEqual({ hours: 72, minutes: 0 });
    expect(holdTimeLeft(90_001, 0)).toEqual({ hours: 0, minutes: 2 });
    expect(holdTimeLeft(1_000, 1_000)).toBeNull();
    expect(holdTimeLeft(0, 1_000)).toBeNull();
  });
});

describe('buildPeerEntries', () => {
  const message = (over: Partial<PeerMessageView>): PeerMessageView => ({
    id: 'pm', chainId: 'pm', hop: 0, state: 'queued', cause: null, fromSessionId: 'b1', fromName: '', fromMode: '',
    toSessionId: 'a1', toName: '', summary: null, body: '', createdAt: 2_000, updatedAt: 2_000, deliveredAt: null, ...over,
  });

  it('target: the approved message folds into its hold card (one card, not two)', () => {
    const h = view({ state: 'promoted', messageId: 'pm' });
    const entries = buildPeerEntries([message({})], [h], 'a1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'hold', linked: { id: 'pm' } });
  });

  it('sender: a promoted hold is dropped and the message card carries on', () => {
    const entries = buildPeerEntries([message({})], [view({ state: 'promoted', messageId: 'pm' })], 'b1');
    expect(entries.map((e) => e.kind)).toEqual(['message']);
  });

  it('sender keeps held, rejected and expired holds; order is by time', () => {
    const entries = buildPeerEntries(
      [message({ id: 'm0', createdAt: 500 })],
      [view({ id: 'x', state: 'rejected', createdAt: 900 }), view({ id: 'y', createdAt: 100 })],
      'b1',
    );
    expect(entries.map((e) => e.id)).toEqual(['hold-y', 'peer-m0', 'hold-x']);
  });

  it('target still hides refused S1 messages', () => {
    expect(buildPeerEntries([message({ state: 'refused' })], [], 'a1')).toHaveLength(0);
  });
});
