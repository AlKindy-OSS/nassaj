/**
 * Fence languages that the chat renders as a diagram/chart instead of source.
 *
 * Kept in a tiny module of its own so `Markdown.tsx` (main bundle) can decide
 * whether a fence is "rich" without pulling any renderer code; the renderers
 * themselves load lazily through `RichCodeBlock`.
 */

export type RichBlockLang = 'mermaid' | 'vega-lite' | 'vega' | 'd3';

const RICH_LANGS: ReadonlySet<string> = new Set(['mermaid', 'vega-lite', 'vega', 'd3']);

/** Above this size a block is shown as source only (keeps the frame and parser bounded). */
export const MAX_RICH_BLOCK_BYTES = 64 * 1024;

/**
 * Reads the exact fence language from react-markdown's `className`.
 *
 * The match is on the whole `language-<token>` class, hyphens included, so
 * `vega-lite` is never read as `vega` and `d3js` is not `d3`.
 */
export function richLangOf(className: string | undefined): RichBlockLang | null {
  if (!className) return null;
  for (const cls of className.split(/\s+/)) {
    if (!cls.startsWith('language-')) continue;
    const lang = cls.slice('language-'.length).toLowerCase();
    return RICH_LANGS.has(lang) ? (lang as RichBlockLang) : null;
  }
  return null;
}

type MdastNode = {
  type: string;
  position?: { start?: { offset?: number }; end?: { offset?: number } };
  data?: { hProperties?: Record<string, unknown> } & Record<string, unknown>;
  children?: MdastNode[];
};

const OPEN_FENCE_RE = /^[\s>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?[\s>]*(`{3,}|~{3,})/;
const CLOSE_FENCE_RE = /^[\s>]*(`{3,}|~{3,})[ \t]*$/;

/**
 * Whether the source slice of a fenced code node ends with its closing fence.
 *
 * micromark ends an unclosed fence at the end of its container, so during
 * streaming (and in a truncated message) the node exists but its last line is
 * body text. Only a closed fence is safe to hand to a renderer.
 */
export function isClosedFenceSource(slice: string): boolean {
  const lines = slice.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  if (lines.length < 2) return false;
  const open = OPEN_FENCE_RE.exec(lines[0]);
  const close = CLOSE_FENCE_RE.exec(lines[lines.length - 1]);
  if (!open || !close) return false;
  return close[1][0] === open[1][0] && close[1].length >= open[1].length;
}

function visitCode(node: MdastNode, source: string): void {
  if (node.type === 'code') {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (typeof start === 'number' && typeof end === 'number'
      && isClosedFenceSource(source.slice(start, end))) {
      const data = (node.data ??= {});
      data.hProperties = { ...(data.hProperties ?? {}), dataFenceClosed: 'true' };
    }
    return;
  }
  node.children?.forEach((child) => visitCode(child, source));
}

/**
 * remark plugin: marks every fenced code block whose closing fence is present
 * with `data-fence-closed="true"` on the resulting `<code>` element.
 */
export function remarkFenceClosed() {
  return (tree: MdastNode, file: { value?: unknown }) => {
    visitCode(tree, String(file.value ?? ''));
  };
}

/** Reads the marker set by `remarkFenceClosed` from a hast `code` element. */
export function isClosedFenceNode(node: unknown): boolean {
  const props = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props?.dataFenceClosed === 'true';
}

/** Parses a Vega/Vega-Lite block. JSON only: a spec is data, never code. */
export function parseSpec(source: string): { spec: Record<string, unknown> } | { error: string } {
  try {
    const value: unknown = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'spec must be a JSON object' };
    }
    return { spec: value as Record<string, unknown> };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'invalid JSON' };
  }
}
