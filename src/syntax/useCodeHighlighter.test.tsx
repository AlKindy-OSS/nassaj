/**
 * useCodeHighlighter.test.tsx — التفضيل يسري بلا إعادة تحميل، وبلا وميض.
 *
 * الاختباران الحاسمان هنا:
 *   1. تغيير الإعداد من نافذة الإعدادات يصل إلى كتلة شيفرة معروضة أصلاً (الحدث
 *      نفسه الذي يبثّه `useUiPreferences`) — لا انتظار لإعادة تحميل الصفحة.
 *   2. مرجع المكوِّن لا يتغيّر بين المستويات. لو تغيّر لأعادت React تركيب كل
 *      كتلة شيفرة في المحادثة، وهذا هو الوميض بعينه.
 *
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 */
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UI_PREFERENCES_STORAGE_KEY, UI_PREFERENCES_SYNC_EVENT } from '../hooks/useUiPreferences';

import { CodeHighlighter } from './prismRegistry';
import { resetCodeHighlightScopeCache, useCodeHighlighter } from './useCodeHighlighter';

function writePreference(scope: string): void {
  window.localStorage.setItem(
    UI_PREFERENCES_STORAGE_KEY,
    JSON.stringify({ showThinking: true, codeHighlightScope: scope }),
  );
}

/** يحاكي بثّ `useUiPreferences` بعد كتابة الإعداد (نفس اسم الحدث والحمولة). */
function announceChange(): void {
  window.dispatchEvent(
    new CustomEvent(UI_PREFERENCES_SYNC_EVENT, {
      detail: { storageKey: UI_PREFERENCES_STORAGE_KEY, sourceId: 'settings-panel', value: {} },
    }),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  resetCodeHighlightScopeCache();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetCodeHighlightScopeCache();
});

describe('useCodeHighlighter', () => {
  it('starts at the statically bundled scope when nothing is stored', () => {
    const { result } = renderHook(() => useCodeHighlighter());
    expect(result.current.scope).toBe('core');
  });

  it('reads the stored scope from the shared uiPreferences key', () => {
    writePreference('full');
    const { result } = renderHook(() => useCodeHighlighter());
    expect(result.current.scope).toBe('full');
  });

  it('ignores a corrupt preferences blob instead of breaking highlighting', () => {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, '{not json');
    const { result } = renderHook(() => useCodeHighlighter());
    expect(result.current.scope).toBe('core');
  });

  it('applies a settings change live, with no reload and no remount', () => {
    const { result, rerender } = renderHook(() => useCodeHighlighter());
    const componentBefore = result.current.SyntaxHighlighter;
    expect(result.current.scope).toBe('core');

    act(() => {
      writePreference('extended');
      announceChange();
    });
    rerender();

    expect(result.current.scope).toBe('extended');
    // المرجع نفسه ⇒ React تُعيد الرسم لا التركيب ⇒ لا وميض في كتل الشيفرة.
    expect(result.current.SyntaxHighlighter).toBe(componentBefore);
  });

  it('picks up a change made in another tab (storage event)', () => {
    const { result, rerender } = renderHook(() => useCodeHighlighter());

    act(() => {
      writePreference('full');
      window.dispatchEvent(
        new StorageEvent('storage', { key: UI_PREFERENCES_STORAGE_KEY, newValue: '{}' }),
      );
    });
    rerender();

    expect(result.current.scope).toBe('full');
  });

  it('exposes the one shared highlighter component', () => {
    const { result } = renderHook(() => useCodeHighlighter());
    expect(result.current.SyntaxHighlighter).toBe(CodeHighlighter);
  });

  it('keeps rendered code intact across a scope change (no blank frame)', () => {
    const source = 'echo hi\n';
    function Block() {
      const { SyntaxHighlighter } = useCodeHighlighter();
      return <SyntaxHighlighter language="bash">{source}</SyntaxHighlighter>;
    }

    const { container } = render(<Block />);
    expect(container.textContent).toContain('echo');

    act(() => {
      writePreference('extended');
      announceChange();
    });

    // الكتلة ما تزال معروضة بمحتواها بعد التبديل مباشرةً — لا فراغ ولا انهيار.
    expect(container.textContent).toContain('echo');
    expect(container.querySelector('pre code')).not.toBeNull();
  });
});
