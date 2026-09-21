import { createRef } from 'react';
import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useTerminalConnection } from '../../hooks/useTerminalConnection';
import type { TerminalSummary } from '../../types/types';

import TerminalView from './TerminalView';

vi.mock('../../hooks/useTerminalConnection', () => ({
  useTerminalConnection: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const terminal: TerminalSummary = {
  id: 'term-1',
  title: 'طرفية عربية',
  cwd: '/workspace',
  status: 'running',
  exitCode: null,
  signal: null,
  createdAt: '2026-09-03T00:00:00.000Z',
  lastActivityAt: '2026-09-03T00:00:00.000Z',
  attached: true,
  hasInitialCommand: false,
};

describe('TerminalView keyboard focus', () => {
  const focus = vi.fn();

  beforeEach(() => {
    focus.mockClear();
    vi.mocked(useTerminalConnection).mockReturnValue({
      terminalContainerRef: createRef<HTMLDivElement>(),
      state: 'attached',
      truncated: false,
      exitInfo: null,
      errorMessage: null,
      reconnect: vi.fn(),
      focus,
    });
  });

  it('redirects keyboard focus and pointer activation to xterm', () => {
    const { getByLabelText } = render(
      <TerminalView terminal={terminal} isActive onRequestListRefresh={vi.fn()} />,
    );
    const surface = getByLabelText(terminal.title);

    expect(surface.getAttribute('tabindex')).toBe('0');
    expect(surface.getAttribute('dir')).toBe('ltr');
    fireEvent.focus(surface);
    fireEvent.pointerDown(surface);

    expect(focus).toHaveBeenCalledTimes(2);
  });
});
