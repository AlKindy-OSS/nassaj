import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveSessionRowIndicatorState } from '../../components/sidebar/view/subcomponents/sessionRowIndicatorState';
import { applyOutcomeSnapshot } from '../../stores/sessionCompletionStore';
import { setSessionProcessState } from '../../stores/sessionProcessStateStore';
import {
  __resetWorkflowStatusStore,
  setActiveWorkflows,
} from '../../stores/workflowStatusStore';

import SessionProcessBadge from './SessionProcessBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const SESSION = 'session-1';

afterEach(() => {
  cleanup();
  setSessionProcessState(SESSION, 'idle');
  applyOutcomeSnapshot([]);
  __resetWorkflowStatusStore();
});

function outcome(value: 'question' | 'error' | 'done') {
  applyOutcomeSnapshot([{
    sessionId: SESSION,
    outcome: value,
    outcomeAt: '2026-09-01T10:00:00.000Z',
  }]);
}

describe('SessionProcessBadge', () => {
  it('renders nothing for a quiet session', () => {
    const { container } = render(<SessionProcessBadge sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it.each([
    ['running', 'text-success'],
    ['frozen', 'text-warning'],
  ] as const)('يكتب كلمة %s لا صورةً وحدها', (state, tone) => {
    setSessionProcessState(SESSION, state);
    render(<SessionProcessBadge sessionId={SESSION} />);

    const pill = screen.getByTitle(`sessionProcessState.${state}Hint`);
    // B-824 — الكلمة هي ما فُقد أصلاً، لا حجم الأيقونة.
    expect(pill.textContent).toBe(`sessionProcessState.${state}`);
    expect(pill.getAttribute('data-session-status-pill')).toBe(state);
    expect(pill.className).toContain(tone);
    // رموز لا قيم خام: كانت الشارة تستعمل green-500/amber-500/blue-500.
    expect(pill.className).not.toMatch(/(blue|green|emerald|amber|red)-\d{3}/);
  });

  it('لا يخالف الصفَّ في أولوية الحالة أبداً', () => {
    // مصدرٌ واحد للترتيب: كانت الشارة ترفع frozen فوق error/done والصفُّ يعكسها،
    // فيقول السطحان شيئين عن المحادثة نفسها.
    setSessionProcessState(SESSION, 'frozen');
    outcome('error');
    render(<SessionProcessBadge sessionId={SESSION} />);

    const expected = deriveSessionRowIndicatorState('frozen', 'error', false);
    expect(expected).toBe('error');
    expect(screen.getByRole('status').getAttribute('data-session-status-pill')).toBe(expected);
  });

  it('يتبنّى الورشة الجارية كما يتبنّاها الصفّ', () => {
    setActiveWorkflows({
      workflows: [{
        sessionId: SESSION, wfId: 'wf-1', status: 'running', agentsDone: 0, agentsTotal: 2,
        updatedAt: null, agents: [], agentsTruncated: false, dormant: false,
      }],
      eligible: 1, scanned: 1, capped: false, dormant: 0,
    });
    render(<SessionProcessBadge sessionId={SESSION} />);

    expect(screen.getByRole('status').getAttribute('data-session-status-pill')).toBe('running');
  });
});
