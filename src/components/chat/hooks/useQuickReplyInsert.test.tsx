/**
 * T-2027 (ADR-209) — a quick-reply click FILLS the composer and focuses it;
 * it never sends.
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/useQuickReplyInsert.test.tsx
 */
import { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import QuickReplies from '../view/subcomponents/QuickReplies';

import { applyQuickReply, useQuickReplyInsert } from './useQuickReplyInsert';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue || key }),
}));

describe('applyQuickReply', () => {
  it.each([
    ['fills an empty composer', '', 'A', null, 'A'],
    ['fills a whitespace-only composer', '  \n', 'A', null, 'A'],
    ['replaces the previously inserted option', 'A', 'B', 'A', 'B'],
    ['prepends to text the user typed', 'my notes', 'A', null, 'A\nmy notes'],
    ['replaces only the prefix after a prepend', 'A\nmy notes', 'B', 'A', 'B\nmy notes'],
    ['prepends when the user edited the inserted option', 'A edited', 'B', 'A', 'B\nA edited'],
  ])('%s', (_label, current, option, last, expected) => {
    expect(applyQuickReply(current, option, last)).toBe(expected);
  });
});

function Harness({ initial = '', onSend }: { initial?: string; onSend: () => void }) {
  const [input, setInput] = useState(initial);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const onQuickReply = useQuickReplyInsert(setInput, textareaRef);
  return (
    <form onSubmit={(event) => { event.preventDefault(); onSend(); }}>
      <QuickReplies choices={['شغّلته', 'لم يعمل']} onSelect={onQuickReply} />
      <textarea aria-label="composer" ref={textareaRef} value={input} onChange={(e) => setInput(e.target.value)} />
      <button type="submit">send</button>
    </form>
  );
}

describe('useQuickReplyInsert in a composer', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  const setup = (initial = '') => {
    const onSend = vi.fn();
    const view = render(<Harness initial={initial} onSend={onSend} />);
    const composer = view.getByLabelText('composer') as HTMLTextAreaElement;
    const click = (name: string) => act(() => { fireEvent.click(view.getByRole('button', { name })); });
    return { view, composer, click, onSend };
  };

  it('fills, focuses with the caret at the end, marks the choice and never sends', () => {
    const { composer, click, onSend, view } = setup();
    click('شغّلته');
    expect(composer.value).toBe('شغّلته');
    expect(document.activeElement).toBe(composer);
    expect(composer.selectionStart).toBe(composer.value.length);
    expect(view.getByRole('button', { name: 'شغّلته' }).getAttribute('aria-pressed')).toBe('true');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('a second click replaces the previous option', () => {
    const { composer, click } = setup();
    click('شغّلته');
    click('لم يعمل');
    expect(composer.value).toBe('لم يعمل');
  });

  it('forgets the inserted prefix when the session changes', () => {
    let value = '';
    const setInput = (next: string | ((current: string) => string)) => {
      value = typeof next === 'function' ? next(value) : next;
    };
    const textareaRef = { current: null };
    const { result, rerender } = renderHook(({ sessionId }) => useQuickReplyInsert(setInput, textareaRef, sessionId), {
      initialProps: { sessionId: 'session-a' as string | null },
    });
    act(() => result.current('شغّلته'));
    expect(value).toBe('شغّلته');
    act(() => result.current('لم يعمل'));
    expect(value).toBe('لم يعمل');
    rerender({ sessionId: 'session-b' });
    act(() => result.current('شغّلته'));
    expect(value).toBe('شغّلته\nلم يعمل');
  });

  it('prepends to typed text, then a second click replaces only that prefix', () => {
    const { composer, click, onSend } = setup('السجل يقول: timeout');
    click('لم يعمل');
    expect(composer.value).toBe('لم يعمل\nالسجل يقول: timeout');
    click('شغّلته');
    expect(composer.value).toBe('شغّلته\nالسجل يقول: timeout');
    expect(onSend).not.toHaveBeenCalled();
  });
});
