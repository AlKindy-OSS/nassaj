/**
 * Shared run-status wording for ClaudeStatus and AgentStatusCard (B-1695).
 *
 * Providers and client hooks emit raw English status words ("Processing",
 * "Working...", "Waiting for permission"); both status surfaces map them to
 * i18n keys so every harness shows the localized label.
 */
type Translate = (key: string, options?: { defaultValue?: string }) => string;

export const ACTION_KEYS = [
  'claudeStatus.actions.thinking',
  'claudeStatus.actions.processing',
  'claudeStatus.actions.analyzing',
  'claudeStatus.actions.working',
  'claudeStatus.actions.computing',
  'claudeStatus.actions.reasoning',
];
export const DEFAULT_ACTION_WORDS = ['Thinking', 'Processing', 'Analyzing', 'Working', 'Computing', 'Reasoning'];

const STATUS_TEXT_KEYS: Record<string, string> = {
  ...Object.fromEntries(DEFAULT_ACTION_WORDS.map((word, i) => [word.toLowerCase(), ACTION_KEYS[i]])),
  'waiting for permission': 'claudeStatus.actions.waitingPermission',
};

const TRAILING_ELLIPSIS = /[.…]+$/;

/** Drops trailing dots/ellipsis; the animated dots span supplies them (no stray dots in RTL). */
export function stripTrailingEllipsis(text: string): string {
  return text.replace(TRAILING_ELLIPSIS, '');
}

/** i18n key for a known raw status word, or undefined for unknown text. */
export function statusTranslationKey(text: string): string | undefined {
  const normalized = stripTrailingEllipsis(text.trim()).toLowerCase();
  return Object.prototype.hasOwnProperty.call(STATUS_TEXT_KEYS, normalized)
    ? STATUS_TEXT_KEYS[normalized]
    : undefined;
}

/** Localized status text; unknown text passes through unchanged. */
export function localizeStatusText(text: string, t: Translate): string {
  const key = statusTranslationKey(text);
  return key ? t(key, { defaultValue: text }) : text;
}
