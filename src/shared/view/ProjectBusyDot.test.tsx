import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { applyOutcomeSnapshot } from '../../stores/sessionCompletionStore';
import {
  beginSessionProcessConnectionEpoch,
  invalidateSessionProcessAuthority,
  setSessionProcessState,
} from '../../stores/sessionProcessStateStore';

import ProjectBusyDot from './ProjectBusyDot';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const SESSION_IDS = ['session-1', 'session-2'];

afterEach(() => {
  cleanup();
  setSessionProcessState('session-1', 'idle');
  setSessionProcessState('session-2', 'idle');
  applyOutcomeSnapshot([]);
});

function dotTone(hintKey: string): string {
  return screen.getByTitle(`sessionProcessState.${hintKey}`).lastElementChild!.className;
}

describe('ProjectBusyDot', () => {
  it('renders nothing while every session is idle', () => {
    const { container } = render(<ProjectBusyDot sessionIds={SESSION_IDS} />);
    expect(container.firstChild).toBeNull();
  });

  it('يعلن الجلسة المجمَّدة على مستوى المشروع', () => {
    // B-824 — كان المشروع أعمى عن `kill -STOP` تماماً: الصفّ يعرض عنبرياً
    // والمشروع لا يعرض شيئاً، فتختفي جلسةٌ لا تنتهي من تلقاء نفسها.
    setSessionProcessState('session-2', 'frozen');
    render(<ProjectBusyDot sessionIds={SESSION_IDS} />);

    expect(dotTone('projectFrozenHint')).toContain('bg-warning');
    expect(screen.getByTitle('sessionProcessState.projectFrozenHint').querySelector('.animate-ping')).toBeNull();
  });

  it('يبقي الجولة الحيّة أعلى من التجميد', () => {
    setSessionProcessState('session-1', 'running');
    setSessionProcessState('session-2', 'frozen');
    render(<ProjectBusyDot sessionIds={SESSION_IDS} />);

    expect(screen.queryByTitle('sessionProcessState.projectFrozenHint')).toBeNull();
    expect(dotTone('projectBusyHint')).toContain('bg-primary');
  });

  it('يحجب rollup قديماً فور فقدان سلطة المقبس', () => {
    const epoch = beginSessionProcessConnectionEpoch();
    setSessionProcessState('session-1', 'running', { epoch, authoritative: true });
    const { container } = render(<ProjectBusyDot sessionIds={SESSION_IDS} />);

    expect(screen.getByTitle('sessionProcessState.projectBusyHint')).toBeTruthy();
    act(() => invalidateSessionProcessAuthority(epoch));

    expect(container.firstChild).toBeNull();
  });

  it.each([
    ['question', 'projectQuestionHint', 'bg-primary'],
    ['error', 'projectErrorHint', 'bg-danger'],
    ['done', 'projectDoneHint', 'bg-success'],
  ] as const)('يصبغ %s برمز لا بقيمة خام', (outcome, hintKey, tone) => {
    applyOutcomeSnapshot([{
      sessionId: 'session-1',
      outcome,
      outcomeAt: '2026-09-01T10:00:00.000Z',
    }]);
    render(<ProjectBusyDot sessionIds={SESSION_IDS} />);

    const className = dotTone(hintKey);
    expect(className).toContain(tone);
    // كانت النقطة تستعمل `bg-blue-500`/`bg-green-500` بينما يستعمل الصفّ الرموز،
    // فكان المشروع والجلسة يتكلّمان لونين مختلفين عن الحالة نفسها.
    expect(className).not.toMatch(/bg-(blue|green|emerald|amber|red)-\d{3}/);
  });
});
