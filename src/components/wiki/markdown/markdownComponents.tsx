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
import Callout, { parseCallout } from './Callout';

// ---------------------------------------------------------------------------
// Plugin arrays (stable references — created once at module level)
// ---------------------------------------------------------------------------

export const REMARK_PLUGINS = [remarkGfm];
export const REHYPE_PLUGINS = [rehypeRaw];

// ---------------------------------------------------------------------------
// Markdown components map (stable reference — created once at module level)
// ---------------------------------------------------------------------------

export const MARKDOWN_COMPONENTS: Components = {
   
  code: CodeBlock as any,
  // react-markdown wraps fenced code blocks in its own <pre> before handing
  // them to the `code` renderer.  Without this override the DOM ends up with
  // <pre (remark)><pre (CodeBlock)>…</pre></pre>.  We dissolve the outer <pre>
  // by rendering a transparent fragment — CodeBlock owns the only real <pre>.
   
  pre: ({ children }: React.HTMLAttributes<HTMLPreElement>) => <>{children}</>,
  // Size, weight, margins and rules for every one of these live in
  // wiki-panel.css under `.wiki-article <tag>` (0,1,1). That beats Tailwind
  // Typography's `:where()` defaults (0,0,0) without a `prose-*` modifier, and
  // it keeps the whole reading scale legible in one place instead of scattered
  // across a dozen class strings that have to be kept in step by hand.
  h1: ({ children, node }) => <HeadingWithId level={1} node={node}>{children}</HeadingWithId>,
  h2: ({ children, node }) => <HeadingWithId level={2} node={node}>{children}</HeadingWithId>,
  h3: ({ children, node }) => <HeadingWithId level={3} node={node}>{children}</HeadingWithId>,
  p: ({ children }) => <p>{children}</p>,
  ul: ({ children }) => <ul className="list-disc">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  // A blockquote is either a GitHub-style alert (> [!TIP] …) rendered as a
  // Callout, or an ordinary quote. parseCallout returns null for the latter.
  blockquote: ({ children }) => {
    const callout = parseCallout(children);
    if (callout) {
      return <Callout kind={callout.kind}>{callout.body}</Callout>;
    }
    // No `italic`: Arabic has no true italic face, so the browser slants the
    // upright one and the letter joins distort.
    return <blockquote>{children}</blockquote>;
  },

  a: AnchorLink as any,
  table: ({ children }) => (
    /* مؤشر تمرير خفيف (ظل على الحافة) على الجوال.
       The block margin belongs to this container, not to the <table> inside it:
       prose margins on the table painted two empty bands between the border and
       the first row. `.wiki-table-scroll > table` zeroes them in CSS. */
    <div className="wiki-table-scroll overflow-x-auto border">
      <table className="min-w-full border-collapse">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  /* No uppercase/tracking here: wiki tables are Arabic, and letter-spacing
     breaks the cursive joins that make Arabic legible. */
  th: ({ children }) => <th className="border-b">{children}</th>,
  td: ({ children }) => <td className="border-b">{children}</td>,
  hr: () => <hr />,
};
