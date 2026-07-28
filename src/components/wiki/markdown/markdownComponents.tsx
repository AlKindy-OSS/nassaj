/**
 * markdownComponents.tsx — ReactMarkdown component map and plugin lists.
 *
 * INVARIANT — REHYPE_PLUGINS uses rehype-raw (raw HTML pass-through):
 *   Content loaded here is build-time-trusted (docs/team-wiki/*.md, committed
 *   to the repo). No sanitization is intentional for this source.
 *   Any future dynamic or user-supplied content MUST add rehype-sanitize before
 *   this pipeline — never pass untrusted markdown through REHYPE_PLUGINS as-is.
 */

import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import type { Components } from 'react-markdown';
import CodeBlock from './CodeBlock';
import HeadingWithId from './HeadingWithId';
import AnchorLink from './AnchorLink';

// ---------------------------------------------------------------------------
// Plugin arrays (stable references — created once at module level)
// ---------------------------------------------------------------------------

export const REMARK_PLUGINS = [remarkGfm];
export const REHYPE_PLUGINS = [rehypeRaw];

// ---------------------------------------------------------------------------
// Markdown components map (stable reference — created once at module level)
// ---------------------------------------------------------------------------

export const MARKDOWN_COMPONENTS: Components = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  code: CodeBlock as any,
  // react-markdown wraps fenced code blocks in its own <pre> before handing
  // them to the `code` renderer.  Without this override the DOM ends up with
  // <pre (remark)><pre (CodeBlock)>…</pre></pre>.  We dissolve the outer <pre>
  // by rendering a transparent fragment — CodeBlock owns the only real <pre>.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pre: ({ children }: React.HTMLAttributes<HTMLPreElement>) => <>{children}</>,
  h1: ({ children }) => (
    <HeadingWithId level={1} className="mb-4 mt-0 text-2xl font-bold text-foreground">
      {children}
    </HeadingWithId>
  ),
  h2: ({ children }) => (
    <HeadingWithId
      level={2}
      className="mb-3 mt-6 border-b pb-2 text-xl font-semibold text-foreground [border-bottom-color:var(--wiki-border-strong,hsl(var(--foreground)/0.18))]"
    >
      {children}
    </HeadingWithId>
  ),
  h3: ({ children }) => (
    <HeadingWithId level={3} className="mb-2 mt-4 text-base font-semibold text-foreground">
      {children}
    </HeadingWithId>
  ),
  p: ({ children }) => (
    <p className="my-3 leading-relaxed text-foreground">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1 ps-6 text-foreground">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1 ps-6 text-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-3 border-s-4 border-primary/40 ps-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: AnchorLink as any,
  table: ({ children }) => (
    /* مؤشر تمرير خفيف (ظل على الحافة) على الجوال */
    <div className="wiki-table-scroll my-3 overflow-x-auto rounded-lg border border-border">
      <table className="min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-muted/50">{children}</thead>,
  th: ({ children }) => (
    /* px-2 على الجوال لتقليل فيض الجداول، px-4 على الديسكتوب */
    <th className="border-b border-border px-2 py-2 text-start text-xs font-semibold uppercase tracking-wide text-muted-foreground md:px-4">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-border/40 px-2 py-2 align-top text-start text-foreground/90 md:px-4">
      {children}
    </td>
  ),
  hr: () => (
    <hr
      className="my-6 border-0 border-t"
      style={{ borderTopColor: 'var(--wiki-border-strong, hsl(var(--foreground) / 0.18))' }}
    />
  ),
};
