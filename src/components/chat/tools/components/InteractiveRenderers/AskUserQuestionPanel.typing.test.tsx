/**
 * Regression guard: typing in the "Other" free-text input must update state
 * and show typed text; numeric key shortcuts must not fire while the input has
 * focus.
 *
 * Root cause (2026-09-21): the <kbd>Enter</kbd> badge was positioned absolutely
 * over the end of the input with default pointer-events, so clicking the input
 * near the badge area landed on the badge instead of the input.  The input
 * never received focus and all keystrokes were dropped.  Fix: pointer-events-none
 * on the badge so clicks pass through to the underlying input element.
 *
 * Secondary fix: useLayoutEffect + autoFocus ensure the input is focused
 * synchronously on mount, covering the keyboard-activation path (pressing 0).
 */

import React from 'react';
import { render, cleanup, fireEvent, screen, act } from '@testing-library/react';
import { describe, it, expect, afterEach, vi, beforeAll } from 'vitest';
import i18n from '../../../../../i18n/config.js';
import { AskUserQuestionPanel } from './AskUserQuestionPanel';

function makeRequest(multiSelect = false) {
  return {
    requestId: 'test-req-1',
    toolName: 'AskUserQuestion',
    input: {
      questions: [
        {
          question: 'أيّ خيار تفضّل؟',
          header: 'اختيار',
          multiSelect,
          options: [
            { label: 'خيار أول', description: '' },
            { label: 'خيار ثانٍ', description: '' },
          ],
        },
      ],
    },
  };
}

beforeAll(async () => {
  await i18n.init();
  await i18n.changeLanguage('ar');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AskUserQuestionPanel — Other input typing', () => {
  it('shows typed text after onChange fires on the Other field', async () => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={makeRequest(false) as never}
        onDecision={onDecision}
      />,
    );

    // Activate "Other" option
    const otherBtn = screen.getByText(/غير ذلك/);
    await act(async () => { fireEvent.click(otherBtn); });

    // The text input should now be visible
    const input = screen.getByRole<HTMLInputElement>('textbox');
    expect(input).toBeDefined();

    // Simulate typing via onChange (controlled input)
    await act(async () => {
      fireEvent.change(input, { target: { value: 'نص عربي abc' } });
    });

    // The input value must reflect what was typed
    expect(input.value).toBe('نص عربي abc');
  });

  it('container keydown does not fire when target is the input', async () => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={makeRequest(false) as never}
        onDecision={onDecision}
      />,
    );

    const otherBtn = screen.getByText(/غير ذلك/);
    await act(async () => { fireEvent.click(otherBtn); });

    const input = screen.getByRole<HTMLInputElement>('textbox');

    // Simulate typing '1' — the container's keydown would have called
    // toggleOption which closes the Other input. If the input still exists,
    // the container did not fire.
    await act(async () => {
      fireEvent.keyDown(input, { key: '1', code: 'Digit1' });
      fireEvent.change(input, { target: { value: '1' } });
    });

    expect(input.value).toBe('1');
    // Other input should still be visible (not toggled off by '0' shortcut)
    expect(screen.getByRole('textbox')).toBeDefined();
  });

  it('numeric "0" keydown on the input does not toggle the Other option off', async () => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={makeRequest(false) as never}
        onDecision={onDecision}
      />,
    );

    const otherBtn = screen.getByText(/غير ذلك/);
    await act(async () => { fireEvent.click(otherBtn); });

    const input = screen.getByRole<HTMLInputElement>('textbox');

    await act(async () => {
      fireEvent.keyDown(input, { key: '0', code: 'Digit0' });
      fireEvent.change(input, { target: { value: '0' } });
    });

    // Input still in DOM and has value '0'
    expect(input.value).toBe('0');
    expect(screen.getByRole('textbox')).toBeDefined();
  });

  it('submit decision includes the typed Other text', async () => {
    const onDecision = vi.fn();
    render(
      <AskUserQuestionPanel
        request={makeRequest(false) as never}
        onDecision={onDecision}
      />,
    );

    const otherBtn = screen.getByText(/غير ذلك/);
    await act(async () => { fireEvent.click(otherBtn); });

    const input = screen.getByRole<HTMLInputElement>('textbox');
    await act(async () => {
      fireEvent.change(input, { target: { value: 'إجابة مخصصة' } });
    });

    // Press Enter to submit
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    expect(onDecision).toHaveBeenCalledOnce();
    const [, decision] = onDecision.mock.calls[0];
    expect(decision.allow).toBe(true);
    const answers = (decision.updatedInput as { answers: Record<string, string> }).answers;
    expect(Object.values(answers)[0]).toContain('إجابة مخصصة');
  });

  it('Enter kbd badge has pointer-events-none so it does not intercept input clicks', async () => {
    // Root cause: the <kbd>Enter</kbd> badge sits absolutely over the input end.
    // Without pointer-events-none the badge intercepts clicks and the input
    // never receives focus, so typed text is silently dropped.
    render(
      <AskUserQuestionPanel
        request={makeRequest(false) as never}
        onDecision={vi.fn()}
      />,
    );

    const otherBtn = screen.getByText(/غير ذلك/);
    await act(async () => { fireEvent.click(otherBtn); });

    // Find the kbd badge by text content
    const kbd = screen.getByText('Enter', { selector: 'kbd' });
    expect(kbd).toBeDefined();

    // The badge must carry the Tailwind class that neutralises pointer events
    expect(kbd.className).toContain('pointer-events-none');
  });
});
