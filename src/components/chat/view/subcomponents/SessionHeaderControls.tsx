import type { ReactNode } from 'react';

type Props = {
  /** The participants bar (or any header control). */
  children: ReactNode;
};

/**
 * Session-header controls portalled into the page header. Kept as its own
 * component so the header is render-tested: it must contain only its controls,
 * never stray text between them (a JSX `,` once rendered a visible comma).
 * Team chat (ADR-187) moved from here into the composer toolbar.
 */
export default function SessionHeaderControls({ children }: Props) {
  return <>{children}</>;
}
