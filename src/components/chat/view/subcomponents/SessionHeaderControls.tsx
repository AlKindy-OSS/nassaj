import type { ReactNode } from 'react';

import InternalSessionChat from '../../../internal-session-chat/InternalSessionChat';

type Props = {
  /** The participants bar (or any header control) rendered first. */
  children: ReactNode;
  sessionId: string | null;
  internalChatEnabled: boolean;
};

/**
 * Session-header controls portalled into the page header. Kept as its own
 * component so the header is render-tested: it must contain only its controls,
 * never stray text between them (a JSX `,` once rendered a visible comma).
 */
export default function SessionHeaderControls({ children, sessionId, internalChatEnabled }: Props) {
  // Feature off: the header is exactly what it was before ADR-187 (no wrapper).
  if (!internalChatEnabled) return <>{children}</>;
  return (
    <div className="flex items-center gap-2">
      {children}
      <InternalSessionChat sessionId={sessionId} enabled={internalChatEnabled} />
    </div>
  );
}
