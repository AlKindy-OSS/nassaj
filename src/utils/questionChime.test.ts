/**
 * T-2041 — صوت السؤال: مرّة لكل انتقال، في تبويبٍ واحد، لمن يملك الكتابة.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { Project } from '../types/app';

import {
  getTabIdForTests,
  hasLikelyWriteAccess,
  isMostRecentlyFocusedTab,
  markTabFocused,
  resetQuestionChimeForTests,
  shouldChimeForQuestionDelta,
  type QuestionDelta,
} from './questionChime';

const writer = { projectId: 'p1', canAccess: true } as Project;
const reader = { projectId: 'p1', canAccess: false, isOwner: false, isMember: false } as Project;

const delta = (overrides: Partial<QuestionDelta> = {}): QuestionDelta => ({
  sessionId: 's1',
  outcome: 'question',
  outcomeAt: '2026-10-16T10:00:00.000Z',
  outcomeState: 'visible',
  previousOutcome: null,
  project: writer,
  ...overrides,
});

beforeEach(() => {
  localStorage.clear();
  resetQuestionChimeForTests();
});

describe('shouldChimeForQuestionDelta', () => {
  it('chimes once per transition into question', () => {
    expect(shouldChimeForQuestionDelta(delta())).toBe(true);
    // إعادة بثّ نفس الانتقال (إعادة اتصال/تكرار) لا ترنّ ثانيةً.
    expect(shouldChimeForQuestionDelta(delta())).toBe(false);
    // سؤالٌ جديد لاحق في الجلسة نفسها بعد الإجابة = انتقالٌ جديد.
    expect(shouldChimeForQuestionDelta(delta({ outcomeAt: '2026-10-16T10:05:00.000Z' }))).toBe(true);
  });

  it('does not chime when the session was already on a question', () => {
    expect(shouldChimeForQuestionDelta(delta({ previousOutcome: 'question' }))).toBe(false);
  });

  it('ignores non-question and cleared deltas', () => {
    expect(shouldChimeForQuestionDelta(delta({ outcome: 'done' }))).toBe(false);
    expect(shouldChimeForQuestionDelta(delta({ outcome: null, outcomeState: 'absent' }))).toBe(false);
    expect(shouldChimeForQuestionDelta(delta({ outcomeState: 'seen' }))).toBe(false);
  });

  it('never chimes for a reader or an unknown project', () => {
    expect(shouldChimeForQuestionDelta(delta({ project: reader }))).toBe(false);
    expect(shouldChimeForQuestionDelta(delta({ project: null }))).toBe(false);
    // ورفضُ القارئ لا يحجز الانتقال: لو صار كاتباً قبل الدلتا التالية فلا أثر.
    expect(shouldChimeForQuestionDelta(delta())).toBe(true);
  });

  it('only the most recently focused tab chimes', () => {
    localStorage.setItem('nassajTabFocusStamp', JSON.stringify({ tabId: 'other-tab', at: Date.now() }));
    expect(isMostRecentlyFocusedTab()).toBe(false);
    expect(shouldChimeForQuestionDelta(delta())).toBe(false);

    markTabFocused();
    expect(JSON.parse(localStorage.getItem('nassajTabFocusStamp')!).tabId).toBe(getTabIdForTests());
    expect(shouldChimeForQuestionDelta(delta())).toBe(true);
  });

  it('a missing or corrupt focus stamp lets this tab chime', () => {
    expect(isMostRecentlyFocusedTab()).toBe(true);
    localStorage.setItem('nassajTabFocusStamp', '{not json');
    expect(isMostRecentlyFocusedTab()).toBe(true);
  });
});

describe('hasLikelyWriteAccess', () => {
  it('accepts canAccess, isOwner or isMember and rejects the rest', () => {
    expect(hasLikelyWriteAccess(writer)).toBe(true);
    expect(hasLikelyWriteAccess({ ...reader, isOwner: true })).toBe(true);
    expect(hasLikelyWriteAccess({ ...reader, isMember: true })).toBe(true);
    expect(hasLikelyWriteAccess(reader)).toBe(false);
    expect(hasLikelyWriteAccess(undefined)).toBe(false);
  });
});
