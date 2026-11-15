/**
 * ADR-173 rev.3 P6 (client half) — reading the shared-writing frames the server
 * sends (UI contract in the ADR): session_busy occupancy, the pre-start
 * shared_writing_unsupported refusal, turn_stop_forbidden, user_turn, and the
 * non-starter answer rules for approval prompts.
 */
import { describe, expect, it } from 'vitest';

import {
  SHARED_DENY_NOTE_MAX_CHARS,
  capDenyNote,
  hasSeveralHumanAuthors,
  isTurnStopForbidden,
  lastForkableMessageId,
  permissionAnswerRole,
  readSendRefusalClientMsgId,
  readSessionBusy,
  readSharedWritingRefusal,
  readStoppedBy,
  sharedUserTurnRow,
} from './sharedWriting';

describe('readSessionBusy', () => {
  it('reads the occupancy fields of a session_busy frame', () => {
    expect(readSessionBusy({
      kind: 'error', code: 'session_busy', busyBy: 7, phase: 'scheduled_wake', stuck: false, canStop: false,
    })).toEqual({ busyBy: 7, phase: 'scheduled_wake', stuck: false, canStop: false });
  });

  it('defaults an absent or unknown phase to running and never invents stop rights', () => {
    expect(readSessionBusy({ kind: 'error', code: 'session_busy', phase: 'weird' }))
      .toEqual({ busyBy: null, phase: 'running', stuck: false, canStop: false });
  });

  it('accepts the structured error.code shape and ignores other codes', () => {
    expect(readSessionBusy({ kind: 'error', error: { code: 'session_busy' }, busyBy: '3' })?.busyBy).toBe(3);
    expect(readSessionBusy({ kind: 'error', code: 'spawn_failed' })).toBeNull();
    // no occupancy fields: an older or other-provider refusal keeps the generic banner
    expect(readSessionBusy({ kind: 'error', code: 'session_busy' })).toBeNull();
    expect(readSessionBusy({ kind: 'complete', code: 'session_busy' })).toBeNull();
  });
});

describe('readSharedWritingRefusal', () => {
  it('reads creator, provider and fork offer', () => {
    expect(readSharedWritingRefusal({
      kind: 'complete', code: 'shared_writing_unsupported', success: false, notStarted: true,
      provider: 'codex', creatorName: 'ibrahim', canFork: true,
    })).toEqual({ provider: 'codex', creatorName: 'ibrahim', canFork: true });
  });

  it('is null for any other frame', () => {
    expect(readSharedWritingRefusal({ kind: 'complete', success: false, code: 'spawn_failed' })).toBeNull();
    expect(readSharedWritingRefusal({ kind: 'error', code: 'shared_writing_unsupported' })).toBeNull();
  });

  it('treats a missing creator or fork flag conservatively', () => {
    expect(readSharedWritingRefusal({ kind: 'complete', code: 'shared_writing_unsupported' }))
      .toEqual({ provider: null, creatorName: null, canFork: false });
  });
});

describe('isTurnStopForbidden', () => {
  it('matches only the refused stop frame', () => {
    expect(isTurnStopForbidden({ kind: 'complete', code: 'turn_stop_forbidden', aborted: true })).toBe(true);
    expect(isTurnStopForbidden({ kind: 'complete', aborted: true, success: false })).toBe(false);
    expect(isTurnStopForbidden({ kind: 'error', code: 'turn_stop_forbidden' })).toBe(false);
  });
});

describe('sharedUserTurnRow', () => {
  const frame = {
    kind: 'user_turn', provider: 'claude', sessionId: 's1', role: 'user', content: 'hello there',
    authorUserId: 2, authorName: 'sara', clientMsgId: 'cmid_abc', id: 'srv-1',
    timestamp: '2026-11-15T00:00:00.000Z', imageCount: 2,
  };

  it('turns a colleague prompt into a user text row stamped with its author', () => {
    const row = sharedUserTurnRow(frame, { currentUserId: 1, isOwnMessageId: () => false });
    expect(row).toMatchObject({
      kind: 'text', role: 'user', content: 'hello there', userId: 2, authorName: 'sara',
      sessionId: 's1', provider: 'claude', sharedImageCount: 2,
      // P8 B1: keyed by the server id, never as an optimistic `cmid_` send of the viewer;
      // the send id is kept apart (own-echo checks never confuse it with the viewer's sends).
      id: 'srv-1', sharedTurn: true, sharedClientMsgId: 'cmid_abc',
    });
    expect(row?.clientMsgId).toBeUndefined();
  });

  it('carries the persisted transcript id the server named (messageUuid)', () => {
    const row = sharedUserTurnRow({ ...frame, messageUuid: 'uuid-1' }, { currentUserId: 1, isOwnMessageId: () => false });
    expect(row?.transcriptMessageId).toBe('uuid-1');
  });

  it('drops the echo of the viewer own prompt (by author or by own message id)', () => {
    expect(sharedUserTurnRow(frame, { currentUserId: 2, isOwnMessageId: () => false })).toBeNull();
    expect(sharedUserTurnRow(frame, { currentUserId: 1, isOwnMessageId: (id) => id === 'cmid_abc' })).toBeNull();
  });

  it('never keys the row by a bare cmid when the server id is missing', () => {
    const { id: _omit, ...noId } = frame;
    expect(sharedUserTurnRow(noId, { currentUserId: 1, isOwnMessageId: () => false })?.id).toBe('user_turn_cmid_abc');
  });

  it('refuses frames without a session or text', () => {
    expect(sharedUserTurnRow({ ...frame, sessionId: '' }, { currentUserId: 1, isOwnMessageId: () => false })).toBeNull();
    expect(sharedUserTurnRow({ ...frame, kind: 'text' }, { currentUserId: 1, isOwnMessageId: () => false })).toBeNull();
  });
});

describe('permissionAnswerRole', () => {
  it('is starter when the viewer started the turn or the starter is unknown', () => {
    expect(permissionAnswerRole({ toolName: 'Write' }, 1, 1)).toBe('starter');
    expect(permissionAnswerRole({ toolName: 'Write' }, 1, null)).toBe('starter');
  });

  it('is non_starter for a colleague answering an ordinary prompt', () => {
    expect(permissionAnswerRole({ toolName: 'Write' }, 2, 1)).toBe('non_starter');
  });

  it('is read_only for an external-identity prompt to a non-starter, preferring the frame starter', () => {
    expect(permissionAnswerRole({ toolName: 'mcp__x__y', externalIdentity: true, starterUserId: 1 }, 2, null))
      .toBe('read_only');
    expect(permissionAnswerRole({ toolName: 'mcp__x__y', externalIdentity: true, starterUserId: 2 }, 2, 1))
      .toBe('starter');
  });

  it('keeps question prompts read-only for non-starters (answers are edited input)', () => {
    expect(permissionAnswerRole({ toolName: 'AskUserQuestion' }, 2, 1)).toBe('read_only');
  });

  it('keeps the plan approval read-only for non-starters, as the server refuses them', () => {
    expect(permissionAnswerRole({ toolName: 'ExitPlanMode' }, 2, 1)).toBe('read_only');
    expect(permissionAnswerRole({ toolName: 'ExitPlanMode' }, 1, 1)).toBe('starter');
  });
});

describe('capDenyNote', () => {
  it('caps at 500 characters', () => {
    expect(SHARED_DENY_NOTE_MAX_CHARS).toBe(500);
    expect(capDenyNote('x'.repeat(600))).toHaveLength(500);
    expect(capDenyNote('  short  ')).toBe('short');
  });
});

describe('lastForkableMessageId', () => {
  it('returns the newest transcript id', () => {
    const rows: Array<{ type: string; transcriptMessageId?: string }> = [
      { type: 'assistant', transcriptMessageId: 'a' },
      { type: 'user' },
      { type: 'assistant', transcriptMessageId: 'b' },
      { type: 'assistant', transcriptMessageId: '  ' },
    ];
    expect(lastForkableMessageId(rows)).toBe('b');
    expect(lastForkableMessageId([rows[1]])).toBeNull();
  });
});

describe('readSendRefusalClientMsgId', () => {
  it('names the refused send of a busy refusal or a pre-start refusal', () => {
    expect(readSendRefusalClientMsgId({ kind: 'error', code: 'session_busy', clientMsgId: 'cmid_a' })).toBe('cmid_a');
    expect(readSendRefusalClientMsgId({
      kind: 'complete', success: false, notStarted: true, code: 'shared_writing_forbidden', clientMsgId: 'cmid_b',
    })).toBe('cmid_b');
  });

  it('is null for a refusal without a send id, a run end, or a failed run that started', () => {
    expect(readSendRefusalClientMsgId({ kind: 'error', code: 'session_busy' })).toBeNull();
    expect(readSendRefusalClientMsgId({ kind: 'complete', success: true, clientMsgId: 'cmid_a' })).toBeNull();
    expect(readSendRefusalClientMsgId({ kind: 'complete', success: false, clientMsgId: 'cmid_a' })).toBeNull();
    expect(readSendRefusalClientMsgId({ kind: 'error', code: 'spawn_failed', clientMsgId: 'cmid_a' })).toBeNull();
  });
});

describe('readStoppedBy', () => {
  it('reads who stopped an aborted turn', () => {
    expect(readStoppedBy({ kind: 'complete', aborted: true, stoppedBy: { userId: 3, name: 'sara' } }))
      .toEqual({ userId: 3, name: 'sara' });
    expect(readStoppedBy({ kind: 'complete', aborted: true, stoppedBy: { userId: '3', name: '' } }))
      .toEqual({ userId: 3, name: null });
  });

  it('is null when the frame names no stopper or did not abort', () => {
    expect(readStoppedBy({ kind: 'complete', aborted: true })).toBeNull();
    expect(readStoppedBy({ kind: 'complete', stoppedBy: { userId: 3, name: 'sara' } })).toBeNull();
    expect(readStoppedBy({ kind: 'complete', aborted: true, stoppedBy: { name: 'x' } })).toBeNull();
  });
});

describe('hasSeveralHumanAuthors', () => {
  it('is true only when user messages carry two different author ids', () => {
    expect(hasSeveralHumanAuthors([
      { type: 'user', userId: 1 }, { type: 'assistant', userId: 3 }, { type: 'user', userId: 1 },
    ])).toBe(false);
    expect(hasSeveralHumanAuthors([{ type: 'user', userId: 1 }, { type: 'user' }])).toBe(false);
    expect(hasSeveralHumanAuthors([{ type: 'user', userId: 1 }, { type: 'user', userId: 3 }])).toBe(true);
  });
});
