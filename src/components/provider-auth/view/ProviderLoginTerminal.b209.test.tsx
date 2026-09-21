/**
 * ProviderLoginTerminal.b209.test.tsx — B-209
 *
 * عيبان في نافذة دخول المزوّد، ولكل منهما حارس تفاضلي هنا:
 *
 * (أ) تسلسلات الهروب الخام (`^[[B^[[A`): سببها أن ضغطات المفاتيح تصل الـpty
 *     قبل أن يدخل الـCLI الوضع الخام. الحارس لا يفحص «هل النص مخفي؟» — بل
 *     يفحص **هل وصل المفتاح أصلاً**: ArrowUp/ArrowDown تُبتلع قبل الطرفية،
 *     وتصلها بعد أخذ لوحة المفاتيح صراحةً. الحالتان معاً وإلا فالفحص بلا معنى.
 *
 * (ب) الصمت بعد خروج العملية: الحارس يقابل «خرج بنجاح» بـ«خرج بفشل» بـ«ما زال
 *     يعمل» — ثلاث حالات نصّية مميّزة معلنة عبر role=status، لا وجود/غياب زرّ.
 *
 * Run: npx vitest run src/components/provider-auth/view/ProviderLoginTerminal.b209.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';

import type { Project } from '../../../types/app';

// ─── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; code?: number }) => {
      const base = opts?.defaultValue ?? key;
      return opts?.code !== undefined ? base.replace('{{code}}', String(opts.code)) : base;
    },
    i18n: { language: 'en' },
  }),
}));

/**
 * Stands in for the embedded shell. `ptyKeys` records every key that actually
 * reached the terminal's input surface — the exact thing the pty would have
 * echoed back as `^[[B`. `completeRun` fires the real onComplete callback so a
 * process exit can be driven from the test.
 */
const ptyKeys: string[] = [];
let completeRun: ((code: number) => void) | null = null;
let mountCount = 0;

vi.mock('../../standalone-shell/view/StandaloneShell', () => ({
  default: ({ onComplete }: { onComplete?: (code: number) => void }) => {
    completeRun = onComplete ?? null;
    mountCount += 1;
    return (
      <textarea
        data-testid="pty-input"
        readOnly
        onKeyDown={(e) => ptyKeys.push(e.key)}
      />
    );
  },
}));

import ProviderLoginTerminal from './ProviderLoginTerminal';

// ─── Helpers ────────────────────────────────────────────────────────────────

const PROJECT = { name: 'x', path: '/tmp/x', displayName: 'x' } as unknown as Project;

function renderTerminal(onComplete?: (code: number) => void, onClose = vi.fn()) {
  render(
    <ProviderLoginTerminal
      project={PROJECT}
      command="kimi login"
      provider="kimi"
      onComplete={onComplete}
      onClose={onClose}
    />,
  );
  return { onClose };
}

/** The two keys named in the bug report, sent straight at the terminal. */
function pressArrows() {
  const pty = screen.getByTestId('pty-input');
  fireEvent.keyDown(pty, { key: 'ArrowDown' });
  fireEvent.keyDown(pty, { key: 'ArrowUp' });
}

const statusText = () => screen.getByTestId('login-run-status').textContent ?? '';

beforeEach(() => {
  ptyKeys.length = 0;
  completeRun = null;
  mountCount = 0;
});

afterEach(cleanup);

// ─── (أ) الدرع ──────────────────────────────────────────────────────────────

describe('B-209 (أ) — keystrokes must not reach the pty before it is ready', () => {
  it('swallows arrow keys while the keyboard is held', () => {
    renderTerminal();
    expect(screen.getByTestId('login-keyboard-shield')).toBeTruthy();

    pressArrows();

    // Nothing reached the terminal, so there is nothing for the line discipline
    // to echo back as ^[[B / ^[[A.
    expect(ptyKeys).toEqual([]);
  });

  it('lets the SAME keys through once the operator takes the keyboard', () => {
    renderTerminal();
    fireEvent.click(screen.getByTestId('login-keyboard-shield'));

    expect(screen.queryByTestId('login-keyboard-shield')).toBeNull();
    pressArrows();

    expect(ptyKeys).toEqual(['ArrowDown', 'ArrowUp']);
  });

  it('is not a keyboard trap: Tab and Escape keep their default behaviour (WCAG 2.1.2)', () => {
    renderTerminal();
    const pty = screen.getByTestId('pty-input');

    // Shell focuses xterm itself, so the caret starts inside the shielded area.
    pty.focus();

    // Blocked keys are cancelled outright…
    const arrow = fireEvent.keyDown(pty, { key: 'ArrowDown' });
    expect(arrow).toBe(false); // fireEvent returns false when defaultPrevented

    // …but the two keys that are the way OUT are only kept away from xterm,
    // never cancelled, so the browser still acts on them.
    expect(fireEvent.keyDown(pty, { key: 'Tab' })).toBe(true);
    expect(fireEvent.keyDown(pty, { key: 'Escape' })).toBe(true);
    // And neither leaked into the pty as input.
    expect(ptyKeys).toEqual([]);
  });

  it('the shield is operable by keyboard alone (it is a real button with a name)', () => {
    renderTerminal();
    const shield = screen.getByTestId('login-keyboard-shield');

    expect(shield.tagName).toBe('BUTTON');
    expect(shield.getAttribute('aria-label')).toMatch(/keyboard/i);

    shield.focus();
    expect(document.activeElement).toBe(shield);
  });
});

// ─── (ب) الحالة النهائية ────────────────────────────────────────────────────

describe('B-209 (ب) — the window must never go silent', () => {
  it('says it is still preparing before anything happens', () => {
    renderTerminal();
    const status = screen.getByTestId('login-run-status');

    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(statusText()).toMatch(/keyboard is on hold/i);
    expect(statusText()).toContain('kimi login');
  });

  it('announces a FAILED exit, names the code, and offers a rerun', () => {
    const onComplete = vi.fn();
    renderTerminal(onComplete);
    fireEvent.click(screen.getByTestId('login-keyboard-shield'));

    act(() => completeRun?.(1));

    expect(statusText()).toMatch(/did not complete/i);
    // The code the CLI actually returned, not a generic "something went wrong".
    expect(statusText()).toContain('code 1');
    expect(screen.getByTestId('login-retry')).toBeTruthy();
    // The caller still learns the real exit code.
    expect(onComplete).toHaveBeenCalledWith(1);
  });

  it('announces a SUCCESSFUL exit differently, with no rerun offered', () => {
    renderTerminal();
    fireEvent.click(screen.getByTestId('login-keyboard-shield'));

    act(() => completeRun?.(0));

    expect(statusText()).toMatch(/finished/i);
    expect(statusText()).not.toMatch(/did not complete/i);
    expect(screen.queryByTestId('login-retry')).toBeNull();
    expect(screen.getByTestId('login-close')).toBeTruthy();
  });

  it('moves focus onto the action the exit introduced', () => {
    renderTerminal();
    fireEvent.click(screen.getByTestId('login-keyboard-shield'));

    act(() => completeRun?.(1));

    expect(document.activeElement).toBe(screen.getByTestId('login-retry'));
  });

  it('a rerun starts a NEW pty and puts the keyboard back on hold', () => {
    renderTerminal();
    fireEvent.click(screen.getByTestId('login-keyboard-shield'));
    act(() => completeRun?.(1));

    const before = mountCount;
    fireEvent.click(screen.getByTestId('login-retry'));

    // A fresh shell, not a reconnect to the dead one…
    expect(mountCount).toBe(before + 1);
    // …and the shield is up again, so the same early-keystroke window is closed.
    expect(screen.getByTestId('login-keyboard-shield')).toBeTruthy();
    ptyKeys.length = 0;
    pressArrows();
    expect(ptyKeys).toEqual([]);
  });

  it('Close hands control back to the modal', () => {
    const onClose = vi.fn();
    renderTerminal(undefined, onClose);
    fireEvent.click(screen.getByTestId('login-keyboard-shield'));
    act(() => completeRun?.(0));

    fireEvent.click(screen.getByTestId('login-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
