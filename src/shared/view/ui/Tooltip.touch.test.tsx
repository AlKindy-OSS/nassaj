import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Tooltip from './Tooltip';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

function renderTooltip() {
  const sendFork = vi.fn();
  const view = render(<Tooltip content="Saved response is unavailable" tapToToggle multiline>
    <button disabled onClick={sendFork}>Continue</button>
  </Tooltip>);
  return { ...view, sendFork, trigger: view.getByRole('button').parentElement! };
}

function tap(trigger: HTMLElement) {
  fireEvent.touchStart(trigger, { touches: [{ clientX: 20, clientY: 20 }] });
  fireEvent.touchEnd(trigger, { changedTouches: [{ clientX: 20, clientY: 20 }] });
}

describe('Tooltip touch and compatibility mouse events', () => {
  it('stays open after the mouse enter/leave sequence synthesized after a phone tap', () => {
    const view = renderTooltip();
    tap(view.trigger);
    fireEvent.mouseEnter(view.trigger);
    fireEvent.mouseLeave(view.trigger);
    act(() => vi.advanceTimersByTime(500));
    const tooltip = view.getByRole('tooltip');
    expect(tooltip.textContent).toBe('Saved response is unavailable');
    expect(view.trigger.getAttribute('aria-expanded')).toBeNull();
    expect(view.trigger.getAttribute('aria-describedby')).toBe(tooltip.id);
    expect(view.sendFork).not.toHaveBeenCalled();
  });

  it('a second tap closes it without a compatibility hover reopening it', () => {
    const view = renderTooltip();
    fireEvent.mouseEnter(view.trigger); // Pending hover before the phone tap.
    tap(view.trigger);
    tap(view.trigger);
    fireEvent.mouseEnter(view.trigger);
    act(() => vi.advanceTimersByTime(500));
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it('still closes on an outside pointer or Escape', () => {
    const view = renderTooltip();
    tap(view.trigger);
    fireEvent.pointerDown(document.body);
    expect(view.queryByRole('tooltip')).toBeNull();
    tap(view.trigger);
    fireEvent.keyDown(view.trigger, { key: 'Escape' });
    expect(view.queryByRole('tooltip')).toBeNull();
  });

  it('switches back to mouse hover when an actual mouse enters the trigger', () => {
    const view = renderTooltip();
    tap(view.trigger);
    const event = new Event('pointerover', { bubbles: true });
    Object.defineProperty(event, 'pointerType', { value: 'mouse' });
    fireEvent(view.trigger, event);
    fireEvent.mouseLeave(view.trigger);
    expect(view.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(view.trigger);
    act(() => vi.advanceTimersByTime(350));
    expect(view.getByRole('tooltip')).toBeTruthy();
  });
});
