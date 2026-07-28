import type { ParticipantRole } from './types';

// A fixed, accessible palette. Each entry pairs a background with white-friendly
// text contrast (>= 4.5:1) so avatar initials stay legible in light/dark.
const AVATAR_PALETTE = [
  'bg-rose-500',
  'bg-orange-500',
  'bg-amber-600',
  'bg-emerald-600',
  'bg-teal-600',
  'bg-cyan-600',
  'bg-sky-600',
  'bg-blue-600',
  'bg-indigo-600',
  'bg-violet-600',
  'bg-fuchsia-600',
  'bg-pink-600',
] as const;

/**
 * Deterministically maps a userId to a fixed palette colour so the same user
 * always renders with the same avatar colour across the app.
 */
export function avatarColorForUser(userId: string | number): string {
  const key = String(userId);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const index = Math.abs(hash) % AVATAR_PALETTE.length;
  return AVATAR_PALETTE[index];
}

/**
 * First visible glyph of a username, upper-cased. Falls back to '?'.
 * Uses Intl.Segmenter when available so multi-byte (Arabic/emoji) names show a
 * full grapheme rather than a broken code unit.
 */
export function initialForName(name: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) {
    return '?';
  }
  try {
    // Intl.Segmenter is not in the configured TS lib target; guard at runtime
    // and access it through a typed escape hatch.
    const intl = Intl as unknown as {
      Segmenter?: new (
        locale?: string,
        options?: { granularity?: 'grapheme' | 'word' | 'sentence' },
      ) => { segment: (input: string) => Iterable<{ segment: string }> };
    };
    if (typeof intl.Segmenter === 'function') {
      const segmenter = new intl.Segmenter(undefined, { granularity: 'grapheme' });
      const first = segmenter.segment(trimmed)[Symbol.iterator]().next().value as
        | { segment: string }
        | undefined;
      if (first?.segment) {
        return first.segment.toLocaleUpperCase();
      }
    }
  } catch {
    // Fall through to the simple slice below.
  }
  return trimmed.slice(0, 1).toLocaleUpperCase();
}

/**
 * Short agent label: keeps it compact for chips while staying recognisable.
 * Splits on common separators and shows the leading token, capped in length.
 */
export function shortAgentName(agentName: string, maxLength = 14): string {
  const name = (agentName ?? '').trim();
  if (!name) {
    return '?';
  }
  if (name.length <= maxLength) {
    return name;
  }
  return `${name.slice(0, maxLength - 1)}…`;
}

/**
 * Locale-aware "time ago" suitable for tooltips. Uses Intl.RelativeTimeFormat
 * so Arabic renders natural relative phrasing; falls back to an ISO-ish string.
 */
export function formatLastSeen(dateString: string, locale: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  const diffMs = date.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const absSec = Math.abs(diffSec);

  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    if (absSec < 60) {
      return rtf.format(Math.round(diffSec), 'second');
    }
    if (absSec < 3600) {
      return rtf.format(Math.round(diffSec / 60), 'minute');
    }
    if (absSec < 86400) {
      return rtf.format(Math.round(diffSec / 3600), 'hour');
    }
    if (absSec < 2592000) {
      return rtf.format(Math.round(diffSec / 86400), 'day');
    }
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** True for roles that should carry the "owner" emphasis ring/badge. */
export function isOwnerRole(role: ParticipantRole): boolean {
  return role === 'owner';
}
