import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodeEditorFile } from '../types/types';
import CodeEditor from './CodeEditor';

const doc = vi.hoisted(() => ({
  isDirty: true,
  handleSave: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../../contexts/PaletteOpsContext', () => ({
  usePaletteOps: () => ({ openSettings: vi.fn() }),
}));
vi.mock('../hooks/useCodeEditorSettings', () => ({
  useCodeEditorSettings: () => ({
    isDarkMode: false, wordWrap: false, minimapEnabled: false, showLineNumbers: true, fontSize: 12,
  }),
}));
vi.mock('../hooks/useCodeEditorDocument', () => ({
  useCodeEditorDocument: () => ({
    content: 'x', setContent: vi.fn(), loading: false, saving: false, saveSuccess: false,
    saveError: null, isBinary: false, secretDeclined: false, previewKind: null,
    fileProjectId: 'p1', isDirty: doc.isDirty, handleSave: doc.handleSave, handleDownload: vi.fn(),
  }),
}));
vi.mock('./subcomponents/CodeEditorSurface', () => ({ default: () => null }));
vi.mock('./subcomponents/CodeEditorFooter', () => ({ default: () => null }));
vi.mock('./subcomponents/CodeEditorHeader', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>header-close</button>
  ),
}));

const file = { name: 'a.md', path: 'a.md', projectId: 'p1' } as CodeEditorFile;

// Mirrors how useEditorSidebar wires the editor: the owner decides on close.
const setup = (dirty: boolean) => {
  doc.isDirty = dirty;
  const onRequestClose = vi.fn();
  const onForceClose = vi.fn();
  const onCloseDismiss = vi.fn();
  render(
    <CodeEditor
      file={file}
      onClose={onRequestClose}
      onForceClose={onForceClose}
      onCloseDismiss={onCloseDismiss}
      closePromptOpen={dirty}
      isSidebar
    />,
  );
  return { onRequestClose, onForceClose, onCloseDismiss };
};

describe('CodeEditor unsaved-changes prompt', () => {
  beforeEach(() => doc.handleSave.mockReset());
  afterEach(cleanup);

  it('shows the prompt with save and discard when dirty', () => {
    setup(true);
    expect(screen.getByText('unsavedChanges.save')).toBeTruthy();
    expect(screen.getByText('unsavedChanges.discard')).toBeTruthy();
  });

  it('shows no prompt when clean', () => {
    setup(false);
    expect(screen.queryByText('unsavedChanges.discard')).toBeNull();
  });

  it('discard closes without saving', () => {
    const { onForceClose } = setup(true);
    fireEvent.click(screen.getByText('unsavedChanges.discard'));
    expect(onForceClose).toHaveBeenCalledOnce();
    expect(doc.handleSave).not.toHaveBeenCalled();
  });

  it('save writes first and then closes', async () => {
    doc.handleSave.mockResolvedValue(true);
    const { onForceClose } = setup(true);
    fireEvent.click(screen.getByText('unsavedChanges.save'));
    await waitFor(() => expect(onForceClose).toHaveBeenCalledOnce());
    expect(doc.handleSave).toHaveBeenCalledOnce();
  });

  it('save failure keeps the file open and dismisses the prompt', async () => {
    doc.handleSave.mockResolvedValue(false);
    const { onForceClose, onCloseDismiss } = setup(true);
    fireEvent.click(screen.getByText('unsavedChanges.save'));
    await waitFor(() => expect(onCloseDismiss).toHaveBeenCalledOnce());
    expect(onForceClose).not.toHaveBeenCalled();
  });

  it('keep editing dismisses without closing', () => {
    const { onForceClose, onCloseDismiss } = setup(true);
    fireEvent.click(screen.getByText('unsavedChanges.keepEditing'));
    expect(onCloseDismiss).toHaveBeenCalledOnce();
    expect(onForceClose).not.toHaveBeenCalled();
  });
});
