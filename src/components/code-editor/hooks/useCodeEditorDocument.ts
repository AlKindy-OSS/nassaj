import { useCallback, useEffect, useState } from 'react';
import { api } from '../../../utils/api';
import { SECRET_FILE_DECLINED, requestWithSecretConfirmation } from '../../../utils/secretFileConfirmation';
import type { CodeEditorFile } from '../types/types';
import { isBinaryFile } from '../utils/binaryFile';
import { getPreviewKind } from '../utils/previewableFile';

type UseCodeEditorDocumentParams = {
  file: CodeEditorFile;
  projectPath?: string;
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

export const useCodeEditorDocument = ({ file, projectPath }: UseCodeEditorDocumentParams) => {
  const [content, setContent] = useState('');
  // Last content that matches the disk (loaded or successfully saved); the
  // buffer is dirty when it differs from this.
  const [savedContent, setSavedContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isBinary, setIsBinary] = useState(false);
  // B-1593: whether this buffer came from a secrets file the user confirmed
  // opening ('confirmed'), declined to open ('declined'), or neither.
  const [secretAccess, setSecretAccess] = useState<'none' | 'confirmed' | 'declined'>('none');
  // Some binaries (images, PDFs, audio, video) can be rendered natively, so the
  // editor shows an inline preview instead of the generic binary placeholder.
  const previewKind = getPreviewKind(file.name);
  // `fileProjectId` is the DB primary key passed down from the editor sidebar;
  // the fallback to `projectPath` preserves older callers that didn't yet
  // propagate the identifier.
  const fileProjectId = file.projectId ?? projectPath;
  const filePath = file.path;
  // B-1689: read and save the chat session's overlay copy when opened from chat.
  const fileSessionId = file.sessionId ?? null;
  const fileName = file.name;
  const fileDiffNewString = file.diffInfo?.new_string;
  const fileDiffOldString = file.diffInfo?.old_string;

  useEffect(() => {
    const loadFileContent = async () => {
      try {
        setLoading(true);
        setIsBinary(false);
        setSecretAccess('none');

        // Natively previewable media (image/pdf/audio/video) is rendered by
        // CodeEditorMediaPreview, so there is nothing to read as text here.
        // Clear any buffer left over from a previously opened text file so a
        // stray save can't write stale content over the binary file.
        if (getPreviewKind(file.name)) {
          setContent('');
          setSavedContent('');
          setLoading(false);
          return;
        }

        // Check if file is binary by extension
        if (isBinaryFile(file.name)) {
          setContent('');
          setSavedContent('');
          setIsBinary(true);
          setLoading(false);
          return;
        }

        // Diff payload may already include full old/new snapshots, so avoid disk read.
        if (file.diffInfo && fileDiffNewString !== undefined && fileDiffOldString !== undefined) {
          setContent(fileDiffNewString);
          setSavedContent(fileDiffNewString);
          setLoading(false);
          return;
        }

        if (!fileProjectId) {
          throw new Error('Missing project identifier');
        }

        // B-1593: a project secrets file asks the user before it is opened.
        let readWithConfirmation = false;
        const response = await requestWithSecretConfirmation(
          (confirmSecret) => {
            readWithConfirmation = confirmSecret;
            return api.readFile(fileProjectId, filePath, { confirmSecret, sessionId: fileSessionId });
          },
          { fileName },
        );
        if (response === SECRET_FILE_DECLINED) {
          setSecretAccess('declined');
          setContent('');
          setSavedContent('');
          return;
        }
        if (!response.ok) {
          throw new Error(`Failed to load file: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        setSecretAccess(readWithConfirmation ? 'confirmed' : 'none');
        setContent(data.content);
        setSavedContent(data.content);
      } catch (error) {
        const message = getErrorMessage(error);
        console.error('Error loading file:', error);
        const errorText = `// Error loading file: ${message}\n// File: ${fileName}\n// Path: ${filePath}`;
        setContent(errorText);
        setSavedContent(errorText);
      } finally {
        setLoading(false);
      }
    };

    loadFileContent();
  }, [file.diffInfo, file.name, fileDiffNewString, fileDiffOldString, fileName, filePath, fileProjectId, fileSessionId]);

  /** Resolves true only when the content reached the disk (or there was nothing to write). */
  const handleSave = useCallback(async (): Promise<boolean> => {
    // Preview-only and binary files have no editable text buffer; never write
    // them back (e.g. via Cmd/Ctrl+S) or we'd corrupt the file on disk.
    // A secrets file the user declined to open has no real buffer either.
    if (previewKind || isBinaryFile(fileName) || secretAccess === 'declined') {
      return true;
    }

    setSaving(true);
    setSaveError(null);

    try {
      if (!fileProjectId) {
        throw new Error('Missing project identifier');
      }

      // B-1593: a secrets file opened with confirmation saves with the flag;
      // any other 428 asks the user before writing.
      const response = await requestWithSecretConfirmation(
        (confirmSecret) => api.saveFile(fileProjectId, filePath, content, { confirmSecret, sessionId: fileSessionId }),
        { fileName, alreadyConfirmed: secretAccess === 'confirmed' },
      );
      if (response === SECRET_FILE_DECLINED) {
        return false;
      }

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType?.includes('application/json')) {
          const errorData = await response.json();
          throw new Error(errorData.error || `Save failed: ${response.status}`);
        }

        const textError = await response.text();
        console.error('Non-JSON error response:', textError);
        throw new Error(`Save failed: ${response.status} ${response.statusText}`);
      }

      await response.json();

      setSavedContent(content);
      setSaveSuccess(true);
      setTimeout(() => setSaveSuccess(false), 2000);
      return true;
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Error saving file:', error);
      setSaveError(message);
      return false;
    } finally {
      setSaving(false);
    }
  }, [content, filePath, fileProjectId, fileSessionId, previewKind, fileName, secretAccess]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');

    anchor.href = url;
    anchor.download = file.name;

    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
  }, [content, file.name]);

  return {
    content,
    setContent,
    loading,
    saving,
    saveSuccess,
    saveError,
    isBinary,
    isDirty: !loading && content !== savedContent,
    secretDeclined: secretAccess === 'declined',
    previewKind,
    fileProjectId,
    handleSave,
    handleDownload,
  };
};
