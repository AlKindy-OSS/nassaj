/**
 * The compass hint is a real button: click/Enter/Space calls onSteerClick,
 * and the click never bubbles to a collapsible parent header.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RunStatusSteerHint } from './RunStatusViewerActions';

const t = ((key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key) as never;

afterEach(cleanup);

describe('RunStatusSteerHint', () => {
  it('renders nothing when show is false', () => {
    const { container } = render(<RunStatusSteerHint show={false} t={t} />);
    expect(container.innerHTML).toBe('');
  });

  it('is a button that calls onSteerClick on click without bubbling', () => {
    const onSteerClick = vi.fn();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <RunStatusSteerHint show t={t} onSteerClick={onSteerClick} />
      </div>,
    );
    const button = screen.getByRole('button', { name: 'Steering hint' });
    fireEvent.click(button);
    expect(onSteerClick).toHaveBeenCalledTimes(1);
    expect(parentClick).not.toHaveBeenCalled();
  });
});
