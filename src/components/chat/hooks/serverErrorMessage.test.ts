import { describe, expect, it } from 'vitest';

import ar from '../../../i18n/locales/ar/chat.json';
import en from '../../../i18n/locales/en/chat.json';

import { readServerErrorCode, readServerErrorDetail, resolveServerErrorMessage } from './useChatRealtimeHandlers';

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
