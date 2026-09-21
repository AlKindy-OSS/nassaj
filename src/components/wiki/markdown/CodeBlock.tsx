/**
 * CodeBlock.tsx — Code block renderer for ReactMarkdown.
 *
 * Handles three cases:
 *  1. Inline code (no language, no newline) → styled <code> span.
 *  2. Mermaid fenced block → WikiMermaidDiagram.
 *  3. All other fenced blocks → <pre> with a CopyButton overlay.
 *
 * react-markdown v10 routes ALL <code> nodes here. It also wraps fenced code
 * blocks in its own <pre> before calling this component, which would cause
 * <pre>-inside-<pre> nesting if we render another <pre>. We break the nesting
 * by overriding components.pre (see markdownComponents.tsx) to render a
 * transparent pass-through — so the only real <pre> wrapper lives here.
 */

import { useState, useCallback } from 'react';
import { Copy, Check } from 'lucide-react';

import { useWikiLabels } from '../useWikiLabels';
import WikiMermaidDiagram from '../view/WikiMermaidDiagram';

// ---------------------------------------------------------------------------
// CopyButton
// ---------------------------------------------------------------------------

export function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const { t } = useWikiLabels();

  const handleCopy = useCallback(() => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [code]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      aria-label={copied ? t('code.copied') : t('code.copy')}
      /*
       * Placement is in wiki-panel.css, not here. The button hangs over a
       * `dir="ltr"` code island inside a `dir="rtl"` article: a logical inset
       * (`end-2`) would resolve against the RTL wrapper and land the button on
       * the code's first character, and tailwindcss-rtl compiles such an inset
       * to both physical edges anyway. The stylesheet pins it physically, at
       * the code's own end, with the reason recorded there.
       */
      data-wiki-copy
      className={[
        'rounded p-1 transition-colors',
        copied
          ? 'bg-primary/20 text-primary'
          : 'bg-muted text-muted-foreground opacity-0 group-hover:opacity-100 focus:opacity-100',
      ].join(' ')}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" aria-hidden="true" />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// CodeBlock
// ---------------------------------------------------------------------------

/**
 * Inline detection: a code node is "inline" when it has no language class
 * AND its text content contains no newline. Both conditions must hold:
 *   - language-* class  → always fenced block (explicit language)
 *   - contains \n       → multi-line → block even without a language tag
 */
export default function CodeBlock({
  className,
  children,
}: React.HTMLAttributes<HTMLElement> & { inline?: boolean }) {
  const lang = /language-(\w+)/.exec(className ?? '')?.[1] ?? '';
  const rawText = String(children);
  const code = rawText.replace(/\n$/, '');

  // Inline: no language class AND no newline in content
  const isInline = !lang && !rawText.includes('\n');

  if (isInline) {
    // Padding, radius, size and the LTR isolation are all in wiki-panel.css.
    return <code className="wiki-inline-code">{children}</code>;
  }

  if (lang === 'mermaid') {
    return <WikiMermaidDiagram code={code} />;
  }

  return (
    <div className="group relative">
      <pre className="wiki-code-block">
        {/* lang="en" alongside dir="ltr": the article declares lang="ar", and a
            screen reader asked to pronounce a shell command in Arabic produces
            noise. */}
        <code className={className} lang="en">
          {children}
        </code>
      </pre>
      <CopyButton code={code} />
    </div>
  );
}
