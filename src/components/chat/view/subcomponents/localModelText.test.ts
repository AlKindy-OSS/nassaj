/**
 * localModelText.test.ts — T-2107 stage 5: the engine line names the vendor
 * account each coding agent does not use, and the context floor is the row's own.
 *
 * Run: npx vitest run src/components/chat/view/subcomponents/localModelText.test.ts
 */
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';

import arChat from '../../../../i18n/locales/ar/chat.json';
import enChat from '../../../../i18n/locales/en/chat.json';

import { localBlockText, localEngineLine } from './localModelText';

const i18n = i18next.createInstance();
await i18n.init({ lng: 'en', resources: { en: { chat: enChat }, ar: { chat: arChat } }, ns: ['chat'], defaultNS: 'chat' });

describe('localEngineLine', () => {
  it('names the account each body leaves untouched, in both locales', () => {
    expect(localEngineLine(i18n.getFixedT('en'), 'claude')).toBe('On your own server; no Anthropic account is used');
    expect(localEngineLine(i18n.getFixedT('en'), 'codex')).toBe('On your own server; no OpenAI account is used');
    expect(localEngineLine(i18n.getFixedT('ar'), 'codex')).toContain('OpenAI');
    expect(localEngineLine(i18n.getFixedT('ar'), 'claude')).toContain('Anthropic');
    expect(localEngineLine(i18n.getFixedT('en'), 'dsh')).toBe('On your own server; no DeepSeek account is used');
    expect(localEngineLine(i18n.getFixedT('ar'), 'dsh')).toBe('على خادمك الخاص؛ لا يُستخدم حساب DeepSeek');
  });
});

describe('localBlockText', () => {
  it('states the floor of the row body, not a fixed number', () => {
    const t = i18n.getFixedT('en');
    expect(localBlockText(t, { blocked: 'context_too_small', minContextWindow: 28096 })).toBe('Needs at least 28,096 tokens');
    expect(localBlockText(t, { blocked: 'context_too_small', minContextWindow: 18096 })).toBe('Needs at least 18,096 tokens');
    expect(localBlockText(i18n.getFixedT('ar'), { blocked: 'context_too_small', minContextWindow: 28096 })).toContain('28,096');
  });
});
