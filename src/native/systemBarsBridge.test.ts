import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installSystemBarsBridge } from './systemBarsBridge';

type TestWindow = Window & {
  NassajSystemBars?: { postMessage(message: string): void };
};

const testWindow = window as TestWindow;

async function flushMutations(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('Android system bars bridge', () => {
  beforeEach(() => {
    document.head.innerHTML = '<meta name="theme-color" content="#1A2B3C">';
    delete testWindow.NassajSystemBars;
  });

  afterEach(() => {
    delete testWindow.NassajSystemBars;
    vi.restoreAllMocks();
  });

  it('sends the fixed typed JSON contract with a verified color at startup', () => {
    const postMessage = vi.fn();
    testWindow.NassajSystemBars = { postMessage };

    const cleanup = installSystemBarsBridge();

    expect(postMessage).toHaveBeenCalledOnce();
    expect(JSON.parse(postMessage.mock.calls[0][0])).toEqual({
      type: 'system-bar-theme',
      color: '#1a2b3c',
    });
    cleanup();
  });

  it.each(['red', '#12345', '#12345678', 'javascript:alert(1)', '']) (
    'rejects invalid theme color %j',
    (color) => {
      document.querySelector('meta')?.setAttribute('content', color);
      const postMessage = vi.fn();
      testWindow.NassajSystemBars = { postMessage };

      const cleanup = installSystemBarsBridge();

      expect(postMessage).not.toHaveBeenCalled();
      cleanup();
    },
  );

  it('is a no-op when the native bridge is absent', async () => {
    const cleanup = installSystemBarsBridge();
    document.querySelector('meta')?.setAttribute('content', '#abcdef');

    await flushMutations();
    expect(cleanup).not.toThrow();
  });

  it('mirrors valid meta mutations and ignores invalid or duplicate values', async () => {
    const postMessage = vi.fn();
    testWindow.NassajSystemBars = { postMessage };
    const cleanup = installSystemBarsBridge();
    const meta = document.querySelector('meta');

    meta?.setAttribute('content', 'not-a-color');
    await flushMutations();
    meta?.setAttribute('content', '#AABBCC');
    await flushMutations();
    meta?.setAttribute('content', '#aabbcc');
    await flushMutations();

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(JSON.parse(postMessage.mock.calls[1][0])).toEqual({
      type: 'system-bar-theme',
      color: '#aabbcc',
    });

    cleanup();
    meta?.setAttribute('content', '#ddeeff');
    await flushMutations();
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  it('starts mirroring when theme-color is added after installation', async () => {
    document.head.innerHTML = '';
    const postMessage = vi.fn();
    testWindow.NassajSystemBars = { postMessage };
    const cleanup = installSystemBarsBridge();

    const meta = document.createElement('meta');
    meta.name = 'theme-color';
    meta.content = '#102030';
    document.head.append(meta);
    await flushMutations();

    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: 'system-bar-theme', color: '#102030' }),
    );
    cleanup();
  });
});
