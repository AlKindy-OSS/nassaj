/**
 * T-2046 (Q3): the recall hook on a real textarea — preventDefault only when
 * it consumes the key, and the index advances across presses.
 *
 * Run: NODE_ENV=test npx vitest run src/components/chat/hooks/usePromptRecall.test.tsx
 */
import { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, createEvent } from '@testing-library/react';

import { usePromptRecall } from './usePromptRecall';

afterEach(cleanup);

function Harness({ prompts }: { prompts: string[] }) {
  const [value, setValue] = useState('');
  const onKeyDown = usePromptRecall(prompts, setValue);
  return <textarea aria-label="composer" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKeyDown} />;
}

function press(el: HTMLElement, key: string, init: Record<string, unknown> = {}) {
  const event = createEvent.keyDown(el, { key, ...init });
  fireEvent(el, event);
  return event.defaultPrevented;
}

function caretToEnd(el: HTMLTextAreaElement) {
  el.setSelectionRange(el.value.length, el.value.length);
}

describe('usePromptRecall', () => {
  it('walks up and back down to an empty draft', () => {
    render(<Harness prompts={['b', 'a']} />);
    const el = screen.getByLabelText('composer') as HTMLTextAreaElement;
    expect(press(el, 'ArrowUp')).toBe(true);
    expect(el.value).toBe('b');
    caretToEnd(el);
    press(el, 'ArrowUp');
    expect(el.value).toBe('a');
    caretToEnd(el);
    expect(press(el, 'ArrowUp')).toBe(false);
    press(el, 'ArrowDown');
    expect(el.value).toBe('b');
    caretToEnd(el);
    press(el, 'ArrowDown');
    expect(el.value).toBe('');
  });

  it('does not consume keys while composing or with shift', () => {
    render(<Harness prompts={['b']} />);
    const el = screen.getByLabelText('composer') as HTMLTextAreaElement;
    expect(press(el, 'ArrowUp', { shiftKey: true })).toBe(false);
    expect(press(el, 'ArrowUp', { keyCode: 229 })).toBe(false);
    expect(el.value).toBe('');
  });

  it('does not touch a typed draft', () => {
    render(<Harness prompts={['b']} />);
    const el = screen.getByLabelText('composer') as HTMLTextAreaElement;
    fireEvent.change(el, { target: { value: 'typing' } });
    expect(press(el, 'ArrowUp')).toBe(false);
    expect(el.value).toBe('typing');
  });
});
