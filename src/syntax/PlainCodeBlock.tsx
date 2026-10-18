/**
 * PlainCodeBlock — the highlighter's frame without tokenizing, for blocks over
 * the highlight budget (see `highlightBudget.ts`).
 */
import type { CSSProperties, ReactNode } from 'react';

import { codeHighlightTheme } from './codeHighlightTheme';

type PlainCodeBlockProps = {
  /** Accepted (and ignored) so this is a drop-in for the highlighter. */
  language?: string;
  /** Accepted (and ignored); the theme's pre/code styles are applied directly. */
  style?: unknown;
  customStyle?: CSSProperties;
  codeTagProps?: { style?: CSSProperties };
  children: ReactNode;
};

const THEME = codeHighlightTheme as Record<string, CSSProperties>;
const PRE_STYLE = THEME['pre[class*="language-"]'] ?? {};
const CODE_STYLE = THEME['code[class*="language-"]'] ?? {};

/** Same frame and typography as the highlighter, without tokenizing. */
export function PlainCodeBlock({ customStyle, codeTagProps, children }: PlainCodeBlockProps) {
  return (
    <pre data-plain-code="true" style={{ ...PRE_STYLE, ...customStyle }}>
      <code style={{ ...CODE_STYLE, ...codeTagProps?.style }}>{children}</code>
    </pre>
  );
}
