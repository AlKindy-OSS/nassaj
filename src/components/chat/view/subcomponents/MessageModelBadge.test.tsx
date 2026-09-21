/**
 * MessageModelBadge.test.tsx — B-352
 *
 * الخاصية: نسبة الردّ إلى قائله تأتي من `message.model` وحده. الغياب صمتٌ لا
 * تخمين — لأن أي بديل (نموذج الجلسة، آخر اختيار في المنتقي) يكون خاطئاً بالضبط
 * في الحالة التي وُجدت الشارة لأجلها: محادثة تبدّل نموذجها في منتصفها.
 *
 * Run: NODE_ENV=test npx vitest run \
 *        src/components/chat/view/subcomponents/MessageModelBadge.test.tsx
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

import MessageModelBadge, { shortModelLabel } from './MessageModelBadge';

afterEach(cleanup);

describe('MessageModelBadge — نسبة الردّ', () => {
  it('لا يرسم شيئاً حين لا نموذج (غياب = مجهول، لا افتراض)', () => {
    const { container } = render(<MessageModelBadge />);
    expect(container.innerHTML).toBe('');
  });

  it('لا يرسم شيئاً لقيمة فارغة أو مسافات', () => {
    const { container } = render(<MessageModelBadge model="   " />);
    expect(container.innerHTML).toBe('');
  });

  it('يعرض المعرّف مختصراً ويُبقي الكامل في الـtitle وaria-label', () => {
    render(<MessageModelBadge model="claude-opus-5" />);
    const el = screen.getByText('opus-5');
    expect(el.getAttribute('title')).toBe('claude-opus-5');
    expect(el.getAttribute('aria-label')).toBe('claude-opus-5');
  });

  it('أسماء النماذج لاتينية دائماً — dir=ltr حتى داخل رسالة عربية', () => {
    render(<MessageModelBadge model="kimi-k3" />);
    expect(screen.getByText('kimi-k3').getAttribute('dir')).toBe('ltr');
  });

  it.each([
    ['Codex', 'gpt-5.6-terra'],
    ['Gemini', 'gemini-3-pro'],
    ['OpenCode', 'openai/gpt-5.4'],
    ['Cursor', 'composer-2'],
    ['Kimi', 'kimi-k2.6'],
  ])('يعرض نموذج %s كما أرسله الحارنس، بلا شرط خاص بمزوّد', (_harness, model) => {
    render(<MessageModelBadge model={model} />);
    const label = shortModelLabel(model);
    expect(screen.getByText(label).getAttribute('title')).toBe(model);
  });
});

describe('shortModelLabel — اختصار بلا اختلاق', () => {
  it('يُسقط بادئة claude- وحدها', () => {
    expect(shortModelLabel('claude-opus-5')).toBe('opus-5');
    expect(shortModelLabel('kimi-k2.6')).toBe('kimi-k2.6');
  });

  it('يأخذ ما بعد آخر شرطة مائلة في المعرّفات المؤهَّلة', () => {
    expect(shortModelLabel('glm/glm-5.2')).toBe('glm-5.2');
  });

  it('يقصّ الطويل بعلامة حذف بدل أن يتمدّد السطر', () => {
    const long = shortModelLabel('some-extremely-long-model-identifier-here');
    expect(long.length).toBeLessThanOrEqual(18);
    expect(long.endsWith('…')).toBe(true);
  });

  it('معرّف لا يعرفه يعود كما هو — لا تطبيع ولا تخمين', () => {
    expect(shortModelLabel('mystery-1')).toBe('mystery-1');
  });
});
