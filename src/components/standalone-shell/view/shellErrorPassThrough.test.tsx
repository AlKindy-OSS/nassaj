/**
 * shellErrorPassThrough.test.tsx
 *
 * الحلقة الوسطى، طرفاً لطرف: `StandaloneShell` → `Shell` → `useShellRuntime` →
 * `useShellConnection`. اختبارات الـhook تثبت المنطق، واختبار النافذة يزيّف
 * الطرفية كلها — وبينهما ثلاثة وسطاء لا يحرسها إلا `tsc`. نسيان تمرير
 * `onShellError` في أحدها يعيد اللوح الأسود بصمت والحزمة كلها خضراء.
 *
 * هنا لا يُزيَّف إلا ما لا يعمل في jsdom (xterm وWebSocket)؛ سلسلة المكوّنات
 * الحقيقية هي المختبَرة: يدخل إطار خطأ من السوكت، ويخرج استدعاء عند المستهلك.
 *
 * Run: npx vitest run src/components/standalone-shell/view/shellErrorPassThrough.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';

const terminalWrites: string[] = [];

vi.mock('@xterm/xterm', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    buffer = { active: { baseY: 0, cursorY: 0, length: 0, getLine: () => null } };
    write(data: string) {
      terminalWrites.push(data);
    }
    clear() {}
    reset() {}
    focus() {}
    blur() {}
    dispose() {}
    open() {}
    loadAddon() {}
    scrollToBottom() {}
    refresh() {}
    resize() {}
    getSelection() {
      return '';
    }
    hasSelection() {
      return false;
    }
    attachCustomKeyEventHandler() {}
    registerCharacterJoiner() {
      return 1;
    }
    deregisterCharacterJoiner() {}
    onRender() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
    onResize() {
      return { dispose() {} };
    }
  }
  return { Terminal };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));

vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
    i18n: { language: 'ar' },
  }),
}));

import type { Project } from '../../../types/app';

import StandaloneShell from './StandaloneShell';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.readyState = FakeWebSocket.CLOSED;
  }

  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

const project = {
  name: 'p',
  path: '/p',
  fullPath: '/p',
  displayName: 'p',
} as unknown as Project;

beforeEach(() => {
  FakeWebSocket.instances = [];
  terminalWrites.length = 0;
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  window.localStorage.setItem('auth-token', 'test-token');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('تمرير إطار الخطأ عبر السلسلة كاملة', () => {
  it('إطار من السوكت يصل مستهلك StandaloneShell برسالته ورمزه', async () => {
    const received: ({ message: string; code: string | null } | null)[] = [];

    await act(async () => {
      render(
        <StandaloneShell
          project={project}
          command="claude /login"
          minimal
          onShellError={(error) => {
            received.push(error);
          }}
        />,
      );
    });

    const socket = FakeWebSocket.instances.at(-1);
    expect(socket, 'السلسلة لم تفتح سوكتاً أصلاً').toBeDefined();

    await act(async () => {
      socket?.emit({
        type: 'error',
        message: 'Update maintenance is active',
        code: 'update_maintenance_active',
      });
    });

    expect(received).toEqual([
      { message: 'Update maintenance is active', code: 'update_maintenance_active' },
    ]);
    // ونفس السلسلة كتبته في اللوح: الطرفية لم تعد صامتة.
    expect(terminalWrites.join('')).toContain('Update maintenance is active');
  });

  it('التصفير يعبر السلسلة نفسها حين يثبت أن الـPTY حيّ', async () => {
    const received: ({ message: string; code: string | null } | null)[] = [];

    await act(async () => {
      render(
        <StandaloneShell
          project={project}
          command="claude /login"
          minimal
          onShellError={(error) => {
            received.push(error);
          }}
        />,
      );
    });
    const socket = FakeWebSocket.instances.at(-1);

    await act(async () => {
      socket?.emit({ type: 'error', message: 'Update maintenance is active' });
      socket?.emit({ type: 'output', data: 'ready\r\n' });
    });

    expect(received.at(-1)).toBeNull();
  });
});
