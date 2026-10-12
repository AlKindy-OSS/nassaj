import { useCallback, useEffect, useRef, useState } from 'react';

import {
  getHarnessFiles,
  HarnessFilesError,
  putMyHarnessFilesMode,
  putWorkspaceAllowMemberPrivate,
  type HarnessFilesMode,
  type HarnessFilesView,
} from './harnessFilesApi';

/** Codes after which the shown state is stale: the hook reloads the view. */
const REFETCH_CODES = new Set([
  'HARNESS_FILES_MODE_CHANGED',
  'HARNESS_FILES_PRIVATE_DISABLED',
  'HARNESS_FILES_FEATURE_DISABLED',
  'HARNESS_FILES_PLATFORM',
]);

export type HarnessFilesState = {
  view: HarnessFilesView | null;
  isLoading: boolean;
  loadErrorCode: string | null;
  /** Code of the last failed write; cleared by the next write or `clearSaveError`. */
  saveErrorCode: string | null;
  isSaving: boolean;
  /** `claudeLink` from the last successful personal switch (e.g. `deferred-live-session`). */
  lastClaudeLink: string | null;
  /** `affectedMembers` from the last successful workspace switch. */
  lastAffectedMembers: number | null;
  reload: () => Promise<void>;
  setMyMode: (mode: HarnessFilesMode) => Promise<boolean>;
  setAllowMemberPrivate: (allow: boolean) => Promise<boolean>;
  clearSaveError: () => void;
};

const codeOf = (error: unknown): string => (error instanceof HarnessFilesError ? error.code : 'UNKNOWN');

/**
 * Loads and changes the caller's harness-files state (ADR-203). Writes return
 * `true` on success; on failure the error code is kept for the view to
 * translate, and stale-state codes trigger a reload.
 */
export function useHarnessFiles(enabled = true): HarnessFilesState {
  const [view, setView] = useState<HarnessFilesView | null>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [loadErrorCode, setLoadErrorCode] = useState<string | null>(null);
  const [saveErrorCode, setSaveErrorCode] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [lastClaudeLink, setLastClaudeLink] = useState<string | null>(null);
  const [lastAffectedMembers, setLastAffectedMembers] = useState<number | null>(null);
  const loadIdRef = useRef(0);

  const reload = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    setIsLoading(true);
    try {
      const next = await getHarnessFiles();
      if (loadId !== loadIdRef.current) return;
      setView(next);
      setLoadErrorCode(null);
    } catch (error) {
      if (loadId !== loadIdRef.current) return;
      setLoadErrorCode(codeOf(error));
    } finally {
      if (loadId === loadIdRef.current) setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  const runWrite = useCallback(async <T extends HarnessFilesView>(
    write: () => Promise<T>,
    onDone: (result: T) => void,
  ): Promise<boolean> => {
    setIsSaving(true);
    setSaveErrorCode(null);
    try {
      const result = await write();
      loadIdRef.current += 1; // a newer view supersedes any load in flight
      setView(result);
      onDone(result);
      return true;
    } catch (error) {
      const code = codeOf(error);
      setSaveErrorCode(code);
      if (REFETCH_CODES.has(code)) await reload();
      return false;
    } finally {
      setIsSaving(false);
    }
  }, [reload]);

  const setMyMode = useCallback((mode: HarnessFilesMode) => runWrite(
    () => putMyHarnessFilesMode(mode),
    (result) => setLastClaudeLink(result.claudeLink ?? null),
  ), [runWrite]);

  const setAllowMemberPrivate = useCallback((allow: boolean) => runWrite(
    () => putWorkspaceAllowMemberPrivate(allow),
    (result) => setLastAffectedMembers(result.affectedMembers ?? null),
  ), [runWrite]);

  const clearSaveError = useCallback(() => setSaveErrorCode(null), []);

  return {
    view,
    isLoading,
    loadErrorCode,
    saveErrorCode,
    isSaving,
    lastClaudeLink,
    lastAffectedMembers,
    reload,
    setMyMode,
    setAllowMemberPrivate,
    clearSaveError,
  };
}
