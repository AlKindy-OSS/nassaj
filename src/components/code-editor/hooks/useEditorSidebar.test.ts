import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Project } from '../../../types/app';
import { useEditorSidebar } from './useEditorSidebar';

afterEach(cleanup);

const project = { projectId: 'p1' } as Project;

const setup = (initial: string | null) =>
  renderHook(
    ({ sessionId }: { sessionId: string | null }) =>
      useEditorSidebar({ selectedProject: project, isMobile: false, sessionId }),
    { initialProps: { sessionId: initial } },
  );

describe('useEditorSidebar session binding', () => {
  it('closes the file when switching to another session', () => {
    const { result, rerender } = setup('s1');
    act(() => result.current.handleFileOpen('docs/a.md'));
    expect(result.current.editingFile?.path).toBe('docs/a.md');
    rerender({ sessionId: 's2' });
    expect(result.current.editingFile).toBeNull();
  });

  it('closes the file when leaving a session for a new-session screen', () => {
    const { result, rerender } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    rerender({ sessionId: null });
    expect(result.current.editingFile).toBeNull();
  });

  it('keeps the file on re-render with the same session', () => {
    const { result, rerender } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    rerender({ sessionId: 's1' });
    expect(result.current.editingFile?.path).toBe('a.md');
  });

  it('keeps a file opened in a new session when it receives its real id', () => {
    const { result, rerender } = setup(null);
    act(() => result.current.handleFileOpen('a.md'));
    rerender({ sessionId: 'real-id' });
    expect(result.current.editingFile?.path).toBe('a.md');
  });

  it('B-1689: carries the chat session id only when the opener passes it', () => {
    const { result } = setup('s1');
    act(() => result.current.handleFileOpen('docs/a.md', null, { sessionId: 's1' }));
    expect(result.current.editingFile?.sessionId).toBe('s1');
    act(() => result.current.handleFileOpen('docs/b.md'));
    expect(result.current.editingFile?.sessionId).toBeNull();
  });
});

describe('useEditorSidebar file opened outside any session (Files view)', () => {
  const setupFiles = () =>
    renderHook(
      ({ sessionId }: { sessionId: string | null }) =>
        useEditorSidebar({
          selectedProject: project,
          isMobile: false,
          sessionId,
          isNewSessionScope: false,
        }),
      { initialProps: { sessionId: null as string | null } },
    );

  it('closes the file when an existing session is picked', () => {
    const { result, rerender } = setupFiles();
    act(() => result.current.handleFileOpen('a.md'));
    rerender({ sessionId: 's1' });
    expect(result.current.editingFile).toBeNull();
  });

  it('prompts instead of closing when the file is dirty', () => {
    const { result, rerender } = setupFiles();
    act(() => result.current.handleFileOpen('a.md'));
    act(() => result.current.handleDirtyChange(true));
    rerender({ sessionId: 's1' });
    expect(result.current.editingFile?.path).toBe('a.md');
    expect(result.current.closePromptOpen).toBe(true);
  });

  it('keeps a new-session file across the real id, then closes on a later switch', () => {
    const { result, rerender } = setup(null);
    act(() => result.current.handleFileOpen('a.md'));
    rerender({ sessionId: 'real' });
    expect(result.current.editingFile?.path).toBe('a.md');
    rerender({ sessionId: 's2' });
    expect(result.current.editingFile).toBeNull();
  });
});

describe('useEditorSidebar unsaved-changes guard', () => {
  it('closes immediately on a close request when the file is clean', () => {
    const { result } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    act(() => result.current.handleRequestClose());
    expect(result.current.editingFile).toBeNull();
    expect(result.current.closePromptOpen).toBe(false);
  });

  it('opens the prompt instead of closing when the file is dirty', () => {
    const { result } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    act(() => result.current.handleDirtyChange(true));
    act(() => result.current.handleRequestClose());
    expect(result.current.editingFile?.path).toBe('a.md');
    expect(result.current.closePromptOpen).toBe(true);
  });

  it('keeps the file (with its own project id) and prompts on session switch while dirty', () => {
    const { result, rerender } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    act(() => result.current.handleDirtyChange(true));
    rerender({ sessionId: 's2' });
    expect(result.current.editingFile?.projectId).toBe('p1');
    expect(result.current.closePromptOpen).toBe(true);
  });

  it('dismissing the prompt keeps the file open and dirty', () => {
    const { result } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    act(() => result.current.handleDirtyChange(true));
    act(() => result.current.handleRequestClose());
    act(() => result.current.handleDismissClosePrompt());
    expect(result.current.closePromptOpen).toBe(false);
    expect(result.current.editingFile).not.toBeNull();
    act(() => result.current.handleRequestClose());
    expect(result.current.closePromptOpen).toBe(true);
  });

  it('forced close (discard) closes and clears the prompt', () => {
    const { result } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    act(() => result.current.handleDirtyChange(true));
    act(() => result.current.handleRequestClose());
    act(() => result.current.handleCloseEditor());
    expect(result.current.editingFile).toBeNull();
    expect(result.current.closePromptOpen).toBe(false);
  });

  it('warns on tab unload only while dirty', () => {
    const { result } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    const fire = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(fire()).toBe(false);
    act(() => result.current.handleDirtyChange(true));
    expect(fire()).toBe(true);
  });
});

describe('useEditorSidebar opening another file while dirty', () => {
  const openDirty = () => {
    const hook = setup('s1');
    act(() => hook.result.current.handleFileOpen('a.md'));
    act(() => hook.result.current.handleDirtyChange(true));
    return hook;
  };

  it('prompts and keeps the current file instead of replacing it', () => {
    const { result } = openDirty();
    act(() => result.current.handleFileOpen('b.md'));
    expect(result.current.editingFile?.path).toBe('a.md');
    expect(result.current.closePromptOpen).toBe(true);
  });

  it('opens the requested file after save/discard (forced close)', () => {
    const { result } = openDirty();
    act(() => result.current.handleFileOpen('b.md'));
    act(() => result.current.handleCloseEditor());
    expect(result.current.editingFile?.path).toBe('b.md');
    expect(result.current.closePromptOpen).toBe(false);
  });

  it('keep editing drops the request and stays on the current file', () => {
    const { result } = openDirty();
    act(() => result.current.handleFileOpen('b.md'));
    act(() => result.current.handleDismissClosePrompt());
    expect(result.current.editingFile?.path).toBe('a.md');
    act(() => result.current.handleRequestClose());
    act(() => result.current.handleCloseEditor());
    expect(result.current.editingFile).toBeNull();
  });

  it('opens directly when clean', () => {
    const { result } = setup('s1');
    act(() => result.current.handleFileOpen('a.md'));
    act(() => result.current.handleFileOpen('b.md'));
    expect(result.current.editingFile?.path).toBe('b.md');
    expect(result.current.closePromptOpen).toBe(false);
  });

  it('re-opening the same dirty file does not prompt', () => {
    const { result } = openDirty();
    act(() => result.current.handleFileOpen('a.md'));
    expect(result.current.closePromptOpen).toBe(false);
    expect(result.current.editingFile?.path).toBe('a.md');
  });

  it('a close request clears a pending file so discard closes', () => {
    const { result } = openDirty();
    act(() => result.current.handleFileOpen('b.md'));
    act(() => result.current.handleRequestClose());
    act(() => result.current.handleCloseEditor());
    expect(result.current.editingFile).toBeNull();
  });
});
