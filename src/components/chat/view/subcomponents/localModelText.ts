/**
 * localModelText.ts — the sentences every local-model surface shares, so the
 * picker, the switcher and the header name a local server the same way and none
 * of them can print the raw pin (ADR-227 Decision 10).
 */
import type { TFunction } from 'i18next';

import type { LocalBody, LocalPickerRow, LocalRowBlock, LocalServerName } from './localOverlayRows';

const BLOCK_FALLBACK: Record<LocalRowBlock, string> = {
  context_unknown: 'Set the context window',
  context_too_small: 'Needs at least {{tokens}} tokens',
  address_untested: 'Re-test the connection',
  tls_name_requires_relay: 'https with a host name is not supported yet; use http or an IP address',
  base_url_unsupported: 'This server address is not supported; use a private address on your network',
  model_id_reserved: 'This model id is reserved and cannot run on the Claude body',
  new_chat_only: 'Start a new chat',
  other_server: 'Runs on another server; start a new chat',
};

/** Why a blocked local row cannot be picked here; the floor is the row body's own. */
export function localBlockText(t: TFunction, row: Pick<LocalPickerRow, 'minContextWindow'> & { blocked: LocalRowBlock }): string {
  return t(`localModels.blocked.${row.blocked}`, {
    defaultValue: BLOCK_FALLBACK[row.blocked],
    // Latin digits with grouping, as every token count in the picker.
    tokens: row.minContextWindow.toLocaleString('en-US'),
  });
}

/** "Your local server · <label>" or "Deleted local server". */
export function localServerText(t: TFunction, name: LocalServerName): string {
  return name.kind === 'server'
    ? t('localModels.serverName', { server: name.label, defaultValue: 'Your local server · {{server}}' })
    : t('localModels.deletedServer', { defaultValue: 'Deleted local server' });
}

const ENGINE_LINE_FALLBACK: Record<LocalBody, string> = {
  claude: 'On your own server; no Anthropic account is used',
  codex: 'On your own server; no OpenAI account is used',
  dsh: 'On your own server; no DeepSeek account is used',
};

/** The engine sentence of every local row: which vendor account the body does not use. */
export function localEngineLine(t: TFunction, body: LocalBody): string {
  return t('localModels.engineLine', {
    context: body === 'claude' ? undefined : body,
    defaultValue: ENGINE_LINE_FALLBACK[body],
  });
}

/** The heading of one server's block. */
export function localBlockHeading(t: TFunction, serverLabel: string): string {
  return t('localModels.blockHeading', { server: serverLabel, defaultValue: 'Local models · {{server}}' });
}
