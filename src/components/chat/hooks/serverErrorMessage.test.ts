import { describe, expect, it } from 'vitest';

import ar from '../../../i18n/locales/ar/chat.json';
import en from '../../../i18n/locales/en/chat.json';

import { readServerErrorCode, readServerErrorDetail, resolveServerErrorMessage } from './useChatRealtimeHandlers';
import {
  isPermanentOutboxBlock,
  readServerErrorFence,
  readServerErrorRetryable,
  resolveOutboxFenceAction,
  resolveOutboxFenceReasonKey,
} from '../utils/serverErrorMessage';

const translate = (locale: typeof en | typeof ar) => (key: string, opts?: Record<string, unknown>) => {
  const value = key.split('.').reduce<unknown>((node, part) =>
    node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, locale);
  return typeof value === 'string' ? value : String(opts?.defaultValue ?? key);
};

describe('B-928 safe server error banners', () => {
  it.each([['ar', ar], ['en', en]] as const)('translates the reason and keeps its code in %s', (_name, locale) => {
    const message = resolveServerErrorMessage({ error: { code: 'session_busy' } }, translate(locale));
    expect(message).toBe(`${locale.serverError.session_busy}. ${locale.serverError.codeLabel}: session_busy`);
  });

  it.each([
    { code: 'future_provider_failure' },
    { error: { code: 'future_provider_failure' } },
  ])('preserves an unmapped valid code in either wire shape: %j', (event) => {
    expect(resolveServerErrorMessage(event, translate(en)))
      .toBe(`${en.serverError.unknown}. Code: future_provider_failure`);
  });

  it('prefers a valid structured code and falls back to a valid top-level code', () => {
    expect(resolveServerErrorMessage({ code: 'spawn_failed', error: { code: 'session_busy' } }, translate(en)))
      .toContain('Code: session_busy');
    expect(resolveServerErrorMessage({ code: 'spawn_failed', error: { code: '/private/auth' } }, translate(en)))
      .toBe(`${en.serverError.spawn_failed}. Code: spawn_failed`);
  });

  it.each(['', 'x'.repeat(65), '/private/auth', 'Bearer abc', 'sk-proj-secret', '<script>',
    'error\nsecret', 'error\u202Esecret', 'eyJhbGciOiJIUzI1NiJ9.payload.signature', null, 12])(
    'does not expose an invalid classification: %j', (code) => {
      expect(resolveServerErrorMessage({ code }, translate(ar)))
        .toBe(`${ar.serverError.unknown}. الرمز: SERVER_ERROR_UNCLASSIFIED`);
    },
  );

  it('never exposes raw strings, detail, reason, stack, or arbitrary translation keys', () => {
    for (const event of [
      { error: 'token=secret /home/example/file:123' },
      { reason: 'Bearer secret', error: { detail: 'Error stack /home/example', messageKey: 'outbox.titleDelivered' } },
      { code: 'future_error', error: { detail: 'password=secret', messageKey: 'serverError.session_busy' } },
    ]) {
      const result = resolveServerErrorMessage(event, translate(en));
      expect(result).toContain(en.serverError.unknown);
      expect(result).not.toMatch(/secret|private|Delivered|was not sent/);
    }
  });

  it('accepts only known translation keys when the event has no classification', () => {
    expect(resolveServerErrorMessage({ error: { messageKey: 'serverError.cli_not_installed' } }, translate(en)))
      .toBe(`${en.serverError.cli_not_installed}. Code: SERVER_ERROR_UNCLASSIFIED`);
    expect(resolveServerErrorMessage({ code: 'constructor' }, translate(en)))
      .toBe(`${en.serverError.unknown}. Code: constructor`);
  });

  it('uses truthful context classifications without hiding a server classification', () => {
    expect(resolveServerErrorMessage({ error: 'private stack' }, translate(en), 'abort_failed'))
      .toBe(`${en.serverError.abort_failed}. Code: abort_failed`);
    expect(resolveServerErrorMessage({}, translate(en), 'session_create_failed'))
      .toBe(`${en.serverError.session_create_failed}. Code: session_create_failed`);
    expect(resolveServerErrorMessage({ code: 'future_error' }, translate(en), 'session_create_failed'))
      .toBe(`${en.serverError.unknown}. Code: future_error`);
  });

  it('does not alter the wire readers used by outbox and delivery state', () => {
    const event = { error: { code: 'session_busy', detail: 'existing delivery detail' }, reason: 'legacy detail' };
    expect(readServerErrorCode(event)).toBe('session_busy');
    expect(readServerErrorDetail(event)).toBe('existing delivery detail');
    expect(readServerErrorDetail({ reason: 'legacy detail' })).toBe('legacy detail');
  });
});


describe('B-1076 permission-fence outbox reasons', () => {
  it.each(['effect_scope_fenced', 'generation_blocked'] as const)(
    'isPermanentOutboxBlock is true for %s only with an explicit retryable:false',
    (code) => {
      expect(isPermanentOutboxBlock(code, false)).toBe(true);
      expect(isPermanentOutboxBlock(code, true)).toBe(false);
      expect(isPermanentOutboxBlock(code, null)).toBe(false);
      expect(isPermanentOutboxBlock(code, undefined)).toBe(false);
    },
  );

  it.each(['generation_transitioning', 'actor_revoked_or_stale', 'sqlite_busy', 'unknown', 'run_failed'])(
    'never treats %s as permanent even with retryable:false',
    (code) => {
      expect(isPermanentOutboxBlock(code, false)).toBe(false);
    },
  );

  it('resolves a scope-specific reason key for effect_scope_fenced', () => {
    expect(resolveOutboxFenceReasonKey('effect_scope_fenced', { scopeKind: 'session' }))
      .toBe('outbox.reason.effect_scope_fenced_session');
    expect(resolveOutboxFenceReasonKey('effect_scope_fenced', { scopeKind: 'user_provider_purpose' }))
      .toBe('outbox.reason.effect_scope_fenced_provider');
    expect(resolveOutboxFenceReasonKey('effect_scope_fenced', null))
      .toBe('outbox.reason.effect_scope_fenced_unknown');
    expect(resolveOutboxFenceReasonKey('generation_blocked', null))
      .toBe('outbox.reason.generation_blocked');
    expect(resolveOutboxFenceReasonKey('generation_transitioning', null))
      .toBe('outbox.reason.generation_transitioning');
    expect(resolveOutboxFenceReasonKey('run_failed', null)).toBe('');
  });

  it.each([ar, en])('has both fence reason keys populated in %j', (locale) => {
    expect(locale.outbox.reason.effect_scope_fenced_session).toBeTruthy();
    expect(locale.outbox.reason.effect_scope_fenced_provider).toBeTruthy();
    expect(locale.outbox.reason.effect_scope_fenced_unknown).toBeTruthy();
    expect(locale.outbox.reason.generation_blocked).toBeTruthy();
    expect(locale.outbox.reason.generation_transitioning).toBeTruthy();
    expect(locale.outbox.reason.fenceMemberHint).toBeTruthy();
    expect(locale.outbox.startNewConversation).toBeTruthy();
    expect(locale.outbox.reviewAndUnlock).toBeTruthy();
  });

  it('offers "new conversation" only for a session-scoped effect_scope_fenced', () => {
    expect(resolveOutboxFenceAction('effect_scope_fenced', { scopeKind: 'session' }, false))
      .toEqual([{ kind: 'new_conversation' }]);
    expect(resolveOutboxFenceAction('effect_scope_fenced', { scopeKind: 'user_provider_purpose' }, false))
      .toEqual([]);
    expect(resolveOutboxFenceAction('effect_scope_fenced', null, false)).toEqual([]);
    expect(resolveOutboxFenceAction('generation_blocked', null, false)).toEqual([]);
    expect(resolveOutboxFenceAction('run_failed', { scopeKind: 'session' }, false)).toEqual([]);
  });

  it('offers "review and unlock" to the owner for either permanent code, any scope', () => {
    expect(resolveOutboxFenceAction('generation_blocked', null, true))
      .toEqual([{ kind: 'review_unlock', scopeKind: null }]);
    expect(resolveOutboxFenceAction('effect_scope_fenced', { scopeKind: 'user_provider_purpose' }, true))
      .toEqual([{ kind: 'review_unlock', scopeKind: 'user_provider_purpose' }]);
    // Session scope: the owner sees BOTH actions.
    expect(resolveOutboxFenceAction('effect_scope_fenced', { scopeKind: 'session' }, true))
      .toEqual([{ kind: 'new_conversation' }, { kind: 'review_unlock', scopeKind: 'session' }]);
  });

  it('reads fence and retryable from both the flat and structured wire shapes', () => {
    expect(readServerErrorFence({ fence: { scopeKind: 'session', reasonCode: 'x' } }))
      .toEqual({ scopeKind: 'session', reasonCode: 'x' });
    expect(readServerErrorFence({ error: { fence: { scopeKind: 'generation' } } }))
      .toEqual({ scopeKind: 'generation', reasonCode: undefined });
    expect(readServerErrorFence({ fence: { scopeKind: 'not_a_real_scope' } }))
      .toEqual({ scopeKind: undefined, reasonCode: undefined });
    expect(readServerErrorFence({})).toBeNull();
    expect(readServerErrorRetryable({ retryable: false })).toBe(false);
    expect(readServerErrorRetryable({ error: { retryable: true } })).toBe(true);
    expect(readServerErrorRetryable({})).toBeNull();
  });
});

describe('B-928 shared row and banner classification', () => {
  it.each([ar, en])('keeps known safe descriptions in the selected locale', (locale) => {
    const t = translate(locale);
    for (const [code, key] of [
      ['conversation_not_found', 'sessionNotResumable.message'],
      ['stream_recovery_gap', 'streamRecoveryGap'],
      ['usage_limit', 'serverError.usage_limit'],
      ['authentication_required', 'serverError.authentication_required'],
    ]) {
      expect(resolveServerErrorMessage({ error: { code, detail: '/private/secret' } }, t))
        .toBe(`${t(key)}. ${t('serverError.codeLabel')}: ${code}`);
    }
  });
});
