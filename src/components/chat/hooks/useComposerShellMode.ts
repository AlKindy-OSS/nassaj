/**
 * T-2037 — the composer's explicit shell mode.
 *
 * Only the toggle switches modes: a leading `!` in a chat draft is ordinary
 * chat text. In shell mode Enter runs the draft as a one-shot command in the
 * Shell tab (never in the chat transcript) and Esc leaves the mode.
 *
 * Availability mirrors the server's own question (owner/admin AND the caller's
 * raw-execution tier); the server re-checks every run and stays authoritative.
 * An unavailable toggle is shown disabled with its reason, never hidden.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { useRawExecConfig } from '../../../hooks/useRawExecConfig';
import { alertDialog, confirmDialog } from '../../../shared/dialogs';
import { useOptionalAuth } from '../../auth/context/AuthContext';
import { requestOneShotRun } from '../../shell/oneShot/oneShotRunsStore';
import {
  setComposerShellModeActive,
  subscribeComposerInserts,
} from '../../../stores/composerInsertStore';
import { classifyShellCommand, needsShellConfirm } from '../utils/shellCommandRisk';

export type ShellUnavailableReason = 'loading' | 'forbidden' | 'raw_exec_disabled';

export type ShellAvailability =
  | { available: true; reason: null }
  | { available: false; reason: ShellUnavailableReason };

/** Whether the caller may run composer shell commands, and if not, why. */
export function useShellAvailability(): ShellAvailability {
  const auth = useOptionalAuth();
  const role = auth?.user?.role;
  const isPrivileged = role === 'owner' || role === 'admin';
  const { canUseRaw, loading } = useRawExecConfig(isPrivileged);
  if (!isPrivileged) return { available: false, reason: 'forbidden' };
  if (loading) return { available: false, reason: 'loading' };
  if (!canUseRaw) return { available: false, reason: 'raw_exec_disabled' };
  return { available: true, reason: null };
}

type Options = {
  input: string;
  onClearInput: () => void;
};

export type ComposerShellMode = {
  availability: ShellAvailability;
  /** True only while the user has the mode on AND it is still available. */
  active: boolean;
  toggle: () => void;
  exit: () => void;
  /** Runs the draft (after any risk confirm). Resolves true if a run was requested. */
  run: () => Promise<boolean>;
  handleSubmit: (event: FormEvent<HTMLFormElement>) => void;
  /** Keydown for the textarea while active: Enter runs, Esc exits. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

export function useComposerShellMode({ input, onClearInput }: Options): ComposerShellMode {
  const { t } = useTranslation('chat');
  const availability = useShellAvailability();
  const [enabled, setEnabled] = useState(false);
  const runningRef = useRef(false);
  const active = enabled && availability.available;

  // Attached shell output lands in the draft for review: leave shell mode so
  // that draft can only be sent as chat, never run by a stray Enter.
  useEffect(() => subscribeComposerInserts(() => setEnabled(false)), []);

  useEffect(() => {
    setComposerShellModeActive(active);
    return () => setComposerShellModeActive(false);
  }, [active]);

  const toggle = useCallback(() => {
    if (!availability.available) return;
    setEnabled((previous) => !previous);
  }, [availability.available]);

  const exit = useCallback(() => setEnabled(false), []);

  const run = useCallback(async (): Promise<boolean> => {
    const command = input.trim();
    if (!active || !command || runningRef.current) return false;
    runningRef.current = true;
    try {
      const risk = classifyShellCommand(command);
      if (risk.blocked) {
        await alertDialog({ title: t('shellMode.riskConfirm.title'), message: t('shellMode.blocked'), code: command });
        return false;
      }
      if (needsShellConfirm(risk)) {
        const body = [
          risk.danger ? t('shellMode.riskConfirm.body') : null,
          risk.tmpfs ? t('shellMode.tmpfsWarning') : null,
        ].filter(Boolean).join('\n\n');
        const confirmed = await confirmDialog({
          title: t('shellMode.riskConfirm.title'),
          message: body,
          code: command,
          confirmLabel: t('shellMode.riskConfirm.confirm'),
          tone: risk.danger ? 'danger' : 'default',
        });
        if (!confirmed) return false;
      }
      if (!requestOneShotRun(command)) return false;
      onClearInput();
      return true;
    } finally {
      runningRef.current = false;
    }
  }, [active, input, onClearInput, t]);

  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      void run();
    },
    [run],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setEnabled(false);
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void run();
      }
    },
    [run],
  );

  return { availability, active, toggle, exit, run, handleSubmit, handleKeyDown };
}
