/**
 * DshSelectionDisclosure.test.tsx — T-2108 (qa round 1, HIGH 5): with a local
 * model chosen, the notice says the content goes to the member's own server, not
 * to DeepSeek; the preview, SAFETY.md and system-account facts stay.
 *
 * Run: npx vitest run src/components/chat/view/subcomponents/DshSelectionDisclosure.test.tsx
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import arChat from '../../../../i18n/locales/ar/chat.json';
import enChat from '../../../../i18n/locales/en/chat.json';

import DshSelectionDisclosure from './DshSelectionDisclosure';

const i18n = i18next.createInstance();
await i18n.use(initReactI18next).init({
  lng: 'en', resources: { en: { chat: enChat }, ar: { chat: arChat } }, ns: ['chat'], defaultNS: 'chat',
});

const text = (local: boolean, lng = 'en') => {
  void i18n.changeLanguage(lng);
  render(<I18nextProvider i18n={i18n}><DshSelectionDisclosure local={local} /></I18nextProvider>);
  return screen.getByRole('note').textContent ?? '';
};

afterEach(cleanup);

describe('DshSelectionDisclosure', () => {
  it('a cloud model: the content is sent to DeepSeek', () => {
    expect(text(false)).toContain('sent to DeepSeek');
  });

  it("a local model: the content goes to the member's own server, never to DeepSeek", () => {
    const body = text(true);
    expect(body).toContain('your own local model server');
    expect(body).not.toContain('sent to DeepSeek');
    expect(body).toContain('SAFETY.md');
    expect(body).toContain('same system account');
    expect(body).toContain('developer preview');
  });

  it('the Arabic local copy names the member server and keeps SAFETY.md', () => {
    const body = text(true, 'ar');
    expect(body).toContain('خادم النماذج المحلي الخاص بك');
    expect(body).toContain('SAFETY.md');
    expect(body).not.toContain('تُرسَل محادثتك ومحتوى المشروع إلى DeepSeek');
  });
});
