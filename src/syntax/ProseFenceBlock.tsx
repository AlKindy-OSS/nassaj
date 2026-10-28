/**
 * ProseFenceBlock — the code-block frame for prose fences (B-1674).
 *
 * Same frame and typography as the highlighter, but every source line is its
 * own block (`.nassaj-prose-line`) so the line takes its base direction from
 * its first strong character (`unicode-bidi: plaintext`, see src/index.css).
 * An Arabic line therefore reads in logical order instead of being laid out on
 * the box's LTR base with its segments reversed. Code fences never use this.
 */
import type { CSSProperties } from 'react';

import { codeHighlightTheme } from './codeHighlightTheme';
import { proseFenceLines } from './proseFence';

type ProseFenceBlockProps = {
  /** Accepted (and ignored) so this is a drop-in for the highlighter. */
  language?: string;
  /** Accepted (and ignored); the theme's pre/code styles are applied directly. */
  style?: unknown;
  customStyle?: CSSProperties;
  codeTagProps?: { style?: CSSProperties };
  children: string;
};

const THEME = codeHighlightTheme as Record<string, CSSProperties>;
const PRE_STYLE = THEME['pre[class*="language-"]'] ?? {};
const CODE_STYLE = THEME['code[class*="language-"]'] ?? {};

/** Renders a prose fence with one bidi paragraph per source line. */
export function ProseFenceBlock({ customStyle, codeTagProps, children }: ProseFenceBlockProps) {
  return (
    <pre data-prose-fence="true" style={{ ...PRE_STYLE, ...customStyle }}>
      <code style={{ ...CODE_STYLE, ...codeTagProps?.style }}>
        {proseFenceLines(children).map((line, index, lines) => (
          // Lines are positional; the newline stays in the text so select+copy
          // keeps blank lines (an empty block span would contribute nothing).
          <span key={index} className="nassaj-prose-line">
            {index < lines.length - 1 ? `${line}\n` : line}
          </span>
        ))}
      </code>
    </pre>
  );
}
