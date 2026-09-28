/**
 * T-1903 (ADR-190) — مدخلة «/steer» في قائمة الأوامر: تظهر فقط حين
 * `steerAvailable` (المحسوبة في ChatInterface من useSessionSteer.canSteer)،
 * وتُصنَّف كـinsert (لا execute) لأنها تحتاج نصاً بعدها.
 */

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => {
  const t = (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key;
  return { useTranslation: () => ({ t, i18n: { language: 'en' } }) };
});

vi.mock('../../../utils/api', () => ({
  authenticatedFetch: async () => ({ ok: true, json: async () => ({ builtIn: [], custom: [] }) }),
}));

import { getSlashCommandSelectionMode, isSteerSlashEntry, useSlashCommands } from './useSlashCommands';

const PROJECT = {
  projectId: 'project-1',
  name: 'Nassaj',
  path: '/workspace/nassaj',
  fullPath: '/workspace/nassaj',
} as any;

afterEach(cleanup);
beforeEach(() => localStorage.clear());

function renderCommands(steerAvailable: boolean) {
  return renderHook(() =>
    useSlashCommands({
      selectedProject: PROJECT,
      selectedSession: { id: 'session-1', __provider: 'claude' } as any,
      provider: 'claude',
      input: '',
      setInput: vi.fn(),
      textareaRef: { current: null },
      onExecuteCommand: vi.fn(),
      steerAvailable,
    }),
  );
}

describe('/steer slash entry', () => {
  it('is hidden when the current turn is not steerable', async () => {
    const view = renderCommands(false);
    await waitFor(() => expect(view.result.current.slashCommands.length).toBeGreaterThanOrEqual(0));
    expect(view.result.current.slashCommands.some((c) => c.name === '/steer')).toBe(false);
  });

  it('appears when steerAvailable is true, classified as an insert (needs a following text)', async () => {
    const view = renderCommands(true);
    await waitFor(() => expect(view.result.current.slashCommands.some((c) => c.name === '/steer')).toBe(true));
    const entry = view.result.current.slashCommands.find((c) => c.name === '/steer')!;
    expect(isSteerSlashEntry(entry)).toBe(true);
    expect(getSlashCommandSelectionMode('claude', entry)).toBe('insert');
  });
});
