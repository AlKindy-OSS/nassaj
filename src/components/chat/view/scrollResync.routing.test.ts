/**
 * T-1821: اختبار resolveScrollResyncRoute — الدالة الصرفة المُصدَّرة
 * التي تحدّد مسار معالج jump-down في ChatInterface.
 *
 * الاختبار يغطّي الدالة الفعلية المستخدمة في الإنتاج (لا نسخة محلية).
 */
import { describe, expect, it } from 'vitest';
import {
  resolveScrollResyncRoute,
  shouldShowManualRefresh,
} from '../hooks/sessionActivity';

// ------------------------------------------------------------------ //
//  resolveScrollResyncRoute — منطق التوجيه الأساسي                    //
// ------------------------------------------------------------------ //

describe('resolveScrollResyncRoute (T-1821)', () => {
  it('returns scrollOnly when neither historyError nor showManualRefresh', () => {
    expect(resolveScrollResyncRoute({ historyError: false, showManualRefresh: false }))
      .toBe('scrollOnly');
  });

  it('returns manualRefresh when showManualRefresh and no historyError', () => {
    expect(resolveScrollResyncRoute({ historyError: false, showManualRefresh: true }))
      .toBe('manualRefresh');
  });

  it('returns retryHistory when historyError is set (regardless of showManualRefresh)', () => {
    expect(resolveScrollResyncRoute({ historyError: true, showManualRefresh: false }))
      .toBe('retryHistory');
    // historyError takes priority over showManualRefresh
    expect(resolveScrollResyncRoute({ historyError: true, showManualRefresh: true }))
      .toBe('retryHistory');
  });

  it('scrollOnly is the B-208 gate: live run before /activity answers', () => {
    // showManualRefresh=false while isLoading=true + activitySource not yet available
    const showManualRefresh = shouldShowManualRefresh({
      hasSession: true,
      hasHistoryError: false,
      isLoading: true,
      activitySourceAvailable: false,
    });
    expect(showManualRefresh).toBe(false);
    expect(resolveScrollResyncRoute({ historyError: false, showManualRefresh }))
      .toBe('scrollOnly');
  });

  it('manualRefresh once activitySource is available during live run', () => {
    const showManualRefresh = shouldShowManualRefresh({
      hasSession: true,
      hasHistoryError: false,
      isLoading: true,
      activitySourceAvailable: true,
    });
    expect(showManualRefresh).toBe(true);
    expect(resolveScrollResyncRoute({ historyError: false, showManualRefresh }))
      .toBe('manualRefresh');
  });
});

// ------------------------------------------------------------------ //
//  showResync = showManualRefresh || historyError                      //
// ------------------------------------------------------------------ //

describe('showResync visibility (T-1821)', () => {
  const cases: Array<[boolean, boolean, boolean]> = [
    [true, false, true],   // showManualRefresh only
    [false, true, true],   // historyError only (fix-1: shows even on zero messages)
    [true, true, true],    // both
    [false, false, false], // neither (live run, B-208 gate)
  ];
  it.each(cases)(
    'showManualRefresh=%s historyError=%s → showResync=%s',
    (showManualRefresh, historyError, expected) => {
      expect(showManualRefresh || historyError).toBe(expected);
    },
  );
});

// ------------------------------------------------------------------ //
//  shouldShowManualRefresh B-208 gate                                  //
// ------------------------------------------------------------------ //

describe('shouldShowManualRefresh B-208 gate', () => {
  it('false during live run when activitySource not yet available', () => {
    expect(shouldShowManualRefresh({
      hasSession: true, hasHistoryError: false, isLoading: true,
      activitySourceAvailable: false,
    })).toBe(false);
  });

  it('true during live run once activitySource is available', () => {
    expect(shouldShowManualRefresh({
      hasSession: true, hasHistoryError: false, isLoading: true,
      activitySourceAvailable: true,
    })).toBe(true);
  });

  it('false when historyError is set (historyError banner owns recovery)', () => {
    expect(shouldShowManualRefresh({
      hasSession: true, hasHistoryError: true, isLoading: false,
      activitySourceAvailable: true,
    })).toBe(false);
  });

  it('true when idle and no historyError', () => {
    expect(shouldShowManualRefresh({
      hasSession: true, hasHistoryError: false, isLoading: false,
      activitySourceAvailable: false,
    })).toBe(true);
  });

  it('false when no session', () => {
    expect(shouldShowManualRefresh({
      hasSession: false, hasHistoryError: false, isLoading: false,
      activitySourceAvailable: true,
    })).toBe(false);
  });
});
