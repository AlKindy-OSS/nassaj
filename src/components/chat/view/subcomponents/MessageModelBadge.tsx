/**
 * MessageModelBadge.tsx — B-352: who actually answered THIS message.
 *
 * The chat footer already carried a copy control (whose "MD"/"TXT" tag names
 * the copy FORMAT, not the author) and a timestamp — nothing named the speaker.
 * The session-level chip in the participants bar could not fill that gap: a
 * conversation may change model mid-way (the engine axis is stamped per turn,
 * ADR-037/ADR-073), so a single chip is an average, not an attribution.
 *
 * Rules:
 *   — Renders ONLY from `message.model`, verbatim from the provider. No
 *     inference from the session, the picker, or the previous message: an
 *     unknown author renders nothing rather than a plausible guess.
 *   — The full identifier is always available (tooltip + aria-label); the label
 *     itself shows a shortened form so the footer stays one line. It renders as
 *     bare text — no box: the footer already reads as one row of metadata, and a
 *     frame around the name only added weight without adding meaning.
 */

import { cn } from '../../../../lib/utils';

/**
 * Compact form of a model identifier for inline display.
 *   'claude-opus-5[1m]' → 'opus-5[1m]'
 *   'kimi-k3'           → 'kimi-k3'
 *   'zai/glm-5.2'       → 'glm-5.2'
 * Never invents a name: an id it does not recognise is returned trimmed only.
 */
export function shortModelLabel(model: string, maxLength = 18): string {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return '';
  const afterSlash = trimmed.includes('/')
    ? trimmed.slice(trimmed.lastIndexOf('/') + 1)
    : trimmed;
  const withoutVendorPrefix = afterSlash.replace(/^claude-/, '');
  return withoutVendorPrefix.length > maxLength
    ? `${withoutVendorPrefix.slice(0, maxLength - 1)}…`
    : withoutVendorPrefix;
}

type MessageModelBadgeProps = {
  /** Raw model id from the provider. Empty/absent renders nothing. */
  model?: string;
  className?: string;
};

export default function MessageModelBadge({ model, className }: MessageModelBadgeProps) {
  const raw = (model ?? '').trim();
  if (!raw) return null;

  return (
    /* design-ok: model identifiers are always Latin text — dir="ltr" is correct
       here even inside an RTL message body. */
    <span
      dir="ltr"
      title={raw}
      aria-label={raw}
      className={cn(
        'inline-flex max-w-[12rem] items-center truncate',
        'font-mono text-[10px] leading-none text-muted-foreground',
        className,
      )}
    >
      {shortModelLabel(raw)}
    </span>
  );
}
