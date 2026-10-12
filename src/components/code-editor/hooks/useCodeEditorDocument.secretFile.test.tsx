/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * B-1593: the editor opens a project `.env` only after the user confirms, saves
 * it with the same confirmation, and never saves over a declined file.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const readFile = vi.fn();
const saveFile = vi.fn();
vi.mock('../../../utils/api', () => ({
  api: {
    readFile: (...a: unknown[]) => readFile(...a),
    saveFile: (...a: unknown[]) => saveFile(...a),
  },
}));

import { useCodeEditorDocument } from './useCodeEditorDocument';

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const askAgain = () => jsonResponse(428, { code: 'secret_file_confirmation_required' });
const envFile = { name: '.env', path: '/p/.env', projectId: 'proj-1' };

describe('useCodeEditorDocument with a secrets file', () => {
  beforeEach(() => {
    readFile.mockReset();
    saveFile.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('asks, then opens and saves with the confirmation flag', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    readFile.mockImplementation(async (_p: string, _f: string, { confirmSecret }: { confirmSecret: boolean }) =>
      (confirmSecret ? jsonResponse(200, { content: 'JWT=1' }) : askAgain()));
    saveFile.mockResolvedValue(jsonResponse(200, { success: true }));

    const { result } = renderHook(() => useCodeEditorDocument({ file: envFile as never }));
    await waitFor(() => expect(result.current.content).toBe('JWT=1'));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(readFile.mock.calls.map((call) => call[2])).toEqual([{ confirmSecret: false }, { confirmSecret: true }]);
    expect(result.current.secretDeclined).toBe(false);

    await act(async () => { await result.current.handleSave(); });
    expect(saveFile).toHaveBeenCalledTimes(1);
    expect(saveFile).toHaveBeenCalledWith('proj-1', '/p/.env', 'JWT=1', { confirmSecret: true });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('shows nothing and never saves when the user declines', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    readFile.mockResolvedValue(askAgain());

    const { result } = renderHook(() => useCodeEditorDocument({ file: envFile as never }));
    await waitFor(() => expect(result.current.secretDeclined).toBe(true));
    expect(result.current.content).toBe('');
    expect(readFile).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.handleSave(); });
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('opens an ordinary file without asking', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    readFile.mockResolvedValue(jsonResponse(200, { content: 'hello' }));
    const { result } = renderHook(() => useCodeEditorDocument({
      file: { name: 'a.ts', path: '/p/a.ts', projectId: 'proj-1' } as never,
    }));
    await waitFor(() => expect(result.current.content).toBe('hello'));
    expect(confirm).not.toHaveBeenCalled();
  });
});
