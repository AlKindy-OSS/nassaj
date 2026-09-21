/**
 * Callout.tsx — GitHub-style alert blocks inside wiki markdown.
 *
 *   > [!TIP]
 *   > اضغط Ctrl+K للبحث من أي مكان.
 *
 * Why this exists: the wiki's job is to be scannable by someone who is stuck.
 * Warnings written as ordinary paragraphs read exactly like everything around
 * them and get skipped; a coloured, iconised block does not.
 *
 * remark-gfm does not parse alert syntax, so the marker arrives as literal text
 * at the head of the blockquote's first paragraph. `parseCallout` detects it and
 * returns the children with the marker removed — nothing else in the block is
 * touched, so bold/links/lists inside a callout keep rendering normally.
 */

import { Children, cloneElement, isValidElement } from 'react';
import { Info, Lightbulb, AlertTriangle, AlertOctagon, Flame } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useWikiLabels } from '../useWikiLabels';

// ---------------------------------------------------------------------------
// Kinds
// ---------------------------------------------------------------------------

export type CalloutKind = 'note' | 'tip' | 'warning' | 'important' | 'caution';

const MARKER = /^\s*\[!(NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*\n?/i;

/**
 * Label and icon per kind. Colour is NOT here: each kind sets one local custom
 * property (`--wiki-callout`) in wiki-panel.css, from which the border, the
 * thick start bar, the tint and the label colour are all derived.
 *
 * These five hues are a declared extension of the theme tokens, confined to the
 * wiki. Semantic state needs hues the Al-Kindy navy-and-gold identity does not
 * own, and deriving them from `--primary` would paint every warning navy. What
 * they replace is worse: raw Tailwind palette classes (`blue-500`,
 * `emerald-500`…) that ignore the theme entirely and cannot be audited as a set.
 */
const STYLES: Record<CalloutKind, { icon: LucideIcon }> = {
  note: { icon: Info },
  tip: { icon: Lightbulb },
  important: { icon: AlertOctagon },
  warning: { icon: AlertTriangle },
  caution: { icon: Flame },
};

// ---------------------------------------------------------------------------
// Child-tree helpers
// ---------------------------------------------------------------------------

type WithChildren = { children?: React.ReactNode };

/** Whitespace-only nodes that remark leaves between blocks. */
function isBlank(node: React.ReactNode): boolean {
  return node === null || node === undefined || node === false || node === '\n';
}

/** Text at the very start of the tree, where the alert marker would sit. */
function leadingText(node: React.ReactNode): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const child of node) {
      if (isBlank(child)) continue;
      return leadingText(child);
    }
    return '';
  }
  if (isValidElement(node)) return leadingText((node.props as WithChildren).children);
  return '';
}

/** Same tree with the marker removed from its first text node. */
function stripMarker(node: React.ReactNode): React.ReactNode {
  if (typeof node === 'string') return node.replace(MARKER, '');
  if (Array.isArray(node)) {
    const copy = [...node];
    for (let i = 0; i < copy.length; i += 1) {
      if (isBlank(copy[i])) continue;
      copy[i] = stripMarker(copy[i]);
      break;
    }
    return copy;
  }
  if (isValidElement(node)) {
    return cloneElement(
      node as React.ReactElement<WithChildren>,
      undefined,
      stripMarker((node.props as WithChildren).children),
    );
  }
  return node;
}

/**
 * Detects an alert marker at the head of a blockquote.
 * Returns null for an ordinary quote, which the caller renders as before.
 */
export function parseCallout(
  children: React.ReactNode,
): { kind: CalloutKind; body: React.ReactNode } | null {
  const match = MARKER.exec(leadingText(children));
  if (!match) return null;
  return {
    kind: match[1].toLowerCase() as CalloutKind,
    body: stripMarker(Children.toArray(children)),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Callout({
  kind,
  children,
}: {
  kind: CalloutKind;
  children: React.ReactNode;
}) {
  const { t, langAttr } = useWikiLabels();
  const Icon = STYLES[kind].icon;

  return (
    <div className="wiki-callout" data-kind={kind} role="note">
      <p className="wiki-callout-label" lang={langAttr}>
        <Icon className="h-4 w-4 flex-shrink-0" aria-hidden="true" />
        {t(`callout.${kind}` as 'callout.note')}
      </p>
      {/* Margins collapse to keep a one-paragraph callout tight. */}
      <div className="wiki-callout-body">{children}</div>
    </div>
  );
}
