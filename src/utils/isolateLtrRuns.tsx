import type { ReactNode } from 'react';

/** Quoted commands and path-like runs (`~/.local/bin/claude`, `/usr/bin/claude`). */
const LTR_RUN = /("[^"]+"|[~\w.@-]*\/[\w.@/~<>-]*[\w/~>-])/;

/**
 * Display-only bidi isolation of mixed text: inside Arabic, a path that starts
 * with neutral characters (`~/.`) is otherwise reordered by the bidi
 * algorithm. Each path or quoted command becomes a `<bdi dir="ltr">`; the
 * wording itself is untouched.
 */
export function isolateLtrRuns(text: string): ReactNode[] {
  return text.split(LTR_RUN).map((part, index) => (index % 2 === 1 ? <bdi key={index} dir="ltr">{part}</bdi> : part));
}
