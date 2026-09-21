/**
 * ProviderLoginModal.claudeNotice.test.tsx — **إفادة `claude` قبل الطرفية.**
 *
 * `claude setup-token` لا يُنهي الربط: يطبع رمزاً **يُعرض مرّةً واحدة** ولا
 * يحفظه، ولا يلتقطه نسّاج من الـPTY عمداً (التقاطُه يحوّل سرّاً عابراً إلى
 * محفوظٍ في بافر الجلسة وscrollback الطرفية). فمن أغلق النافذة قبل النسخ فقد
 * أتلف النسخة الوحيدة. وخريطة `DEVICE_AUTH_NOTICES` كانت تغطّي codex وkimi
 * وحدهما — سهوٌ لا استثناء: وُلدت الخريطة (efa5a0b5e) والأمرُ آنذاك `/login`،
 * وحين تحوّل إلى `setup-token` (b1de1d0e7) لم يُلمس هذا الملف.
 *
 * ما يُثبّت هنا: أنّ الإفادة تُقرأ لمزوّد claude، وأنّها تسمّي الخطوتين وموضع
 * اللصق بدقّة، وأنّ إفادتَي codex وkimi لم تنكسرا بإضافتها.
 *
 * RUNNER: vitest (jsdom).
 */
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));

/**
 * `Trans` مزيَّفة تُصيّر `defaults` نصّاً بعد نزع وسوم المكوّنات (`<cmd>`,
 * `<b>`) — فالمفحوص هو **الجملة** لا شجرةُ عناصرها. والافتراضيّات في الكود هي
 * النسخة الإنجليزية نفسها الموجودة في `en/settings.json`.
 */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; provider?: string }) =>
      options?.defaultValue?.replace('{{provider}}', options.provider ?? '') ?? key,
  }),
  Trans: ({ defaults, children }: { defaults?: string; children?: React.ReactNode }) =>
    defaults ? defaults.replace(/<\/?[a-z]+>/g, '') : (children ?? null),
}));

/** الطرفية الحقيقية تفتح websocket؛ ما يُفحص هنا هو ما فوقها. */
vi.mock('./ProviderLoginTerminal', () => ({ default: () => <div data-testid="terminal" /> }));

import ProviderLoginModal from './ProviderLoginModal';

afterEach(cleanup);

const open = (provider: 'claude' | 'codex' | 'kimi') =>
  render(<ProviderLoginModal isOpen provider={provider} onClose={vi.fn()} />);

describe('ProviderLoginModal — the claude notice (setup-token is two steps)', () => {
  it('renders a notice for claude at all — it used to have none', () => {
    open('claude');
    expect(screen.getByTestId('terminal'), 'the terminal still renders below').toBeTruthy();
    expect(screen.getByText(/Two steps: authorize, then paste the token/i)).toBeTruthy();
  });

  it('says the token is printed once and is not captured by nassaj', () => {
    open('claude');
    expect(screen.getByText(/sk-ant-oat01-/)).toBeTruthy();
    expect(
      screen.getByText(/shown once only/i),
      'the operator must know the terminal holds the only copy',
    ).toBeTruthy();
    expect(screen.getByText(/does not capture it from the terminal/i)).toBeTruthy();
  });

  it('names the destination field precisely, not just "settings"', () => {
    open('claude');
    const paste = screen.getByText(/Setup token/);
    expect(paste.textContent).toMatch(/Settings → Agents → Claude → Account/);
    expect(paste.textContent).toMatch(/Save token/);
  });

  it('leaves the codex notice and its generic heading untouched', () => {
    open('codex');
    expect(screen.getByText(/Device Authorization/i)).toBeTruthy();
    expect(screen.getByText(/enter the code to authorize Codex/i)).toBeTruthy();
    expect(screen.queryByText(/paste the token/i)).toBeNull();
  });

  it('leaves the kimi notice and its generic heading untouched', () => {
    open('kimi');
    expect(screen.getByText(/Device Authorization/i)).toBeTruthy();
    expect(screen.getByText(/links a Kimi subscription/i)).toBeTruthy();
    expect(screen.queryByText(/paste the token/i)).toBeNull();
  });
});
