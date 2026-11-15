/**
 * ADR-173 P6: every shared-writing refusal code reads as a plain sentence in
 * both UI languages, never as the generic "unexpected error".
 */
import { describe, expect, it } from 'vitest';

import ar from '../../../i18n/locales/ar/chat.json';
import en from '../../../i18n/locales/en/chat.json';

import { SERVER_ERROR_CODE_KEYS, resolveServerErrorMessage } from './serverErrorMessage';

const translate = (locale: typeof en | typeof ar) => (key: string, opts?: Record<string, unknown>) => {
  const value = key.split('.').reduce<unknown>((node, part) =>
    node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined, locale);
  return typeof value === 'string' ? value : String(opts?.defaultValue ?? key);
};

const CODES = [
  'shared_writing_unsupported',
  'shared_write_transcript_conflict',
  'shared_write_transcript_unavailable',
  'shared_writing_cli_unproven',
  'shared_writing_forbidden',
  'turn_stop_forbidden',
];

describe('shared-writing refusal codes', () => {
  it.each(CODES)('%s has its own sentence in ar and en', (code) => {
    expect(SERVER_ERROR_CODE_KEYS[code]).toBe(`serverError.${code}`);
    for (const locale of [ar, en]) {
      const message = resolveServerErrorMessage({ code }, translate(locale));
      expect(message.startsWith(locale.serverError.unknown)).toBe(false);
      // P8: a refusal the user caused reads as a sentence alone, never with its raw code.
      expect(message).toBe(translate(locale)(`serverError.${code}`));
      expect(message).not.toContain(code);
    }
  });

  it('session_busy reads as a sentence alone in both languages (no raw code)', () => {
    for (const locale of [ar, en]) {
      const message = resolveServerErrorMessage({ code: 'session_busy' }, translate(locale));
      expect(message).toBe(locale.serverError.session_busy);
      expect(message).not.toContain('session_busy');
    }
  });
});
