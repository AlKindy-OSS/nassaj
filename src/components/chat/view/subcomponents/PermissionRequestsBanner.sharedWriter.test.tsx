/**
 * ADR-173 P5/P6 — approval prompts seen by a member who did not start the turn:
 * connector (external identity) prompts and questions are read-only ("waiting
 * for <starter>"); any other prompt offers allow once / deny with a note capped
 * at 500 characters, never "allow & remember".
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const params = Object.entries(options ?? {})
        .filter(([name]) => name !== 'defaultValue')
        .map(([name, value]) => `${name}=${String(value).replace(/[⁨⁩]/g, '')}`);
      return params.length ? `${key}[${params.join(',')}]` : key;
    },
  }),
}));

import type { PendingPermissionRequest } from '../../types/types';

import PermissionRequestsBanner from './PermissionRequestsBanner';

afterEach(cleanup);

const resolveName = (id: number | null) => (id === 1 ? 'ibrahim' : null);

function renderFor(request: Partial<PendingPermissionRequest>, viewerUserId: number, decide = vi.fn()) {
  render(
    <PermissionRequestsBanner
      pendingPermissionRequests={[{ requestId: 'r1', toolName: 'Write', input: { file_path: 'a.txt' }, ...request }]}
      handlePermissionDecision={decide}
      handleGrantToolPermission={vi.fn()}
      viewerUserId={viewerUserId}
      runStarterUserId={1}
      resolveName={resolveName}
    />,
  );
  return decide;
}

describe('external-identity prompt', () => {
  it('is read-only for a non-starter', () => {
    renderFor({ toolName: 'mcp__github__create_issue', externalIdentity: true, starterUserId: 1 }, 2);
    expect(screen.getByText('sharedWriting.approval.waitingFor[name=ibrahim]')).not.toBeNull();
    expect(screen.queryByText('permissions.allowOnce')).toBeNull();
    expect(screen.queryByText('permissions.deny')).toBeNull();
  });

  it('keeps all controls for the starter', () => {
    renderFor({ toolName: 'mcp__github__create_issue', externalIdentity: true, starterUserId: 1 }, 1);
    expect(screen.getByText('permissions.allowOnce')).not.toBeNull();
    expect(screen.getByText('permissions.allowAndRemember')).not.toBeNull();
  });
});

describe('question prompt', () => {
  it('is read-only for a non-starter (answers are edited input)', () => {
    renderFor({ toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which?', options: [] }] } }, 2);
    expect(screen.getByText('sharedWriting.approval.waitingQuestion[name=ibrahim]')).not.toBeNull();
  });
});

describe('ordinary prompt answered by a non-starter', () => {
  it('offers allow once and deny only', () => {
    renderFor({}, 2);
    expect(screen.getByText('permissions.allowOnce')).not.toBeNull();
    expect(screen.getByText('permissions.deny')).not.toBeNull();
    expect(screen.queryByText('permissions.allowAndRemember')).toBeNull();
    expect(screen.queryByText('permissions.allowSaved')).toBeNull();
    expect(screen.getByText('sharedWriting.approval.nonStarterNote[name=ibrahim]')).not.toBeNull();
  });

  it('caps the deny note at 500 characters, shows the counter and sends it', () => {
    const decide = renderFor({}, 2);
    const note = screen.getByLabelText('sharedWriting.approval.denyNoteLabel') as HTMLTextAreaElement;
    expect(note.maxLength).toBe(500);
    fireEvent.change(note, { target: { value: 'y'.repeat(620) } });
    expect(note.value).toHaveLength(500);
    expect(screen.getByText('sharedWriting.approval.counter[count=500,max=500]')).not.toBeNull();
    fireEvent.click(screen.getByText('permissions.deny'));
    expect(decide).toHaveBeenCalledWith('r1', { allow: false, message: 'y'.repeat(500) });
  });

  it('allow once sends no remember entry and no edited input', () => {
    const decide = renderFor({}, 2);
    fireEvent.click(screen.getByText('permissions.allowOnce'));
    expect(decide).toHaveBeenCalledWith('r1', { allow: true });
  });
});
