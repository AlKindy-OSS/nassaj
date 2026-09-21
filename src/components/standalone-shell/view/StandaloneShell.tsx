import { useCallback, useState } from 'react';

import Shell from '../../shell/view/Shell';
import type { ShellErrorInfo } from '../../shell/types/types';
import type { Project, ProjectSession } from '../../../types/app';

import StandaloneShellEmptyState from './subcomponents/StandaloneShellEmptyState';
import StandaloneShellHeader from './subcomponents/StandaloneShellHeader';

type StandaloneShellProps = {
  project?: Project | null;
  session?: ProjectSession | null;
  command?: string | null;
  isPlainShell?: boolean | null;
  /** Explicit provider for the PTY init message (e.g. 'agy'). Forwarded to Shell
   *  so a command-driven plain shell still declares its provider, enabling the
   *  backend per-user credential isolation (resolveProviderEnv → isolated HOME). */
  provider?: string | null;
  isActive?: boolean;
  autoConnect?: boolean;
  onComplete?: ((exitCode: number) => void) | null;
  /** Server refusal (`type: 'error'`), forwarded verbatim, and `null` when the
   *  refusal is superseded. Not a process exit, so it never runs through
   *  onComplete. */
  onShellError?: ((error: ShellErrorInfo | null) => void) | null;
  onClose?: (() => void) | null;
  title?: string | null;
  className?: string;
  showHeader?: boolean;
  compact?: boolean;
  minimal?: boolean;
};

export default function StandaloneShell({
  project = null,
  session = null,
  command = null,
  isPlainShell = null,
  provider = null,
  isActive = true,
  autoConnect = true,
  onComplete = null,
  onShellError = null,
  onClose = null,
  title = null,
  className = '',
  showHeader = true,
  compact = false,
  minimal = false,
}: StandaloneShellProps) {
  const [isCompleted, setIsCompleted] = useState(false);

  // Keep `compact` in the public API for compatibility with existing callers.
  void compact;

  const shouldUsePlainShell = isPlainShell !== null ? isPlainShell : command !== null;

  const handleProcessComplete = useCallback(
    (exitCode: number) => {
      setIsCompleted(true);
      onComplete?.(exitCode);
    },
    [onComplete],
  );

  if (!project) {
    return <StandaloneShellEmptyState className={className} />;
  }

  return (
    <div className={`flex h-full w-full flex-col ${className}`}>
      {!minimal && showHeader && title && (
        <StandaloneShellHeader title={title} isCompleted={isCompleted} onClose={onClose} />
      )}

      <div className="min-h-0 w-full flex-1">
        <Shell
          selectedProject={project}
          selectedSession={session}
          initialCommand={command}
          isPlainShell={shouldUsePlainShell}
          provider={provider}
          isActive={isActive}
          onProcessComplete={handleProcessComplete}
          onShellError={onShellError}
          minimal={minimal}
          autoConnect={minimal ? true : autoConnect}
        />
      </div>
    </div>
  );
}
