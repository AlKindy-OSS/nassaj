/**
 * Two AskUserQuestion prompts on screen at once (the first never got settled on
 * the client) must leave exactly ONE answerable card; the stale one renders
 * read-only so an answer can never target a dead tool_use.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import type { PendingPermissionRequest } from '../../types/types';
import { classifyPendingQuestions } from '../../utils/pendingQuestionState';

import PermissionRequestsBanner from './PermissionRequestsBanner';

afterEach(cleanup);

function ask(requestId: string, question: string): PendingPermissionRequest {
  return {
    requestId,
    toolName: 'AskUserQuestion',
    sessionId: 's1',
    input: { questions: [{ question, options: [{ label: 'تلقائياً' }, { label: 'بموافقتي' }] }] },
  };
}

describe('PermissionRequestsBanner — stale AskUserQuestion', () => {
  it('renders only the newest ask as interactive', () => {
    const requests = [ask('a', 'السؤال القديم'), ask('b', 'السؤال الجديد')];
    const { container } = render(
      <PermissionRequestsBanner
        pendingPermissionRequests={requests}
        pendingQuestionStates={classifyPendingQuestions(requests)}
        handlePermissionDecision={vi.fn()}
        handleGrantToolPermission={vi.fn()}
      />,
    );
    expect(screen.getAllByText('askUser.title')).toHaveLength(1);
    expect(screen.getAllByText('تلقائياً')).toHaveLength(1);
    const stale = container.querySelector('[data-question-state="superseded"]');
    expect(stale?.textContent).toContain('السؤال القديم');
    expect(stale?.querySelector('button')).toBeNull();
  });
});
