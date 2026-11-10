/**
 * localModelText.ts — the sentences every local-model surface shares, so the
 * picker, the switcher and the header name a local server the same way and none
 * of them can print the raw pin (ADR-227 Decision 10).
 */
import type { TFunction } from 'i18next';

import type { LocalRowBlock, LocalServerName } from './localOverlayRows';

const BLOCK_FALLBACK: Record<LocalRowBlock, string> = {
  context_unknown: 'Set the context window',
  context_too_small: 'Needs at least 18,096 tokens',
  address_untested: 'Re-test the connection',
  tls_name_requires_relay: 'https with a host name is not supported yet; use http or an IP address',
  base_url_unsupported: 'This server address is not supported; use a private address on your network',
  model_id_reserved: 'This model id is reserved and cannot run on the Claude body',
  new_chat_only: 'Start a new chat',
  other_server: 'Runs on another server; start a new chat',
};

/** Why a local row cannot be picked here. */
export function localBlockText(t: TFunction, block: LocalRowBlock): string {
  return t(`localModels.blocked.${block}`, { defaultValue: BLOCK_FALLBACK[block] });
}

/** "Your local server · <label>" or "Deleted local server". */
export function localServerText(t: TFunction, name: LocalServerName): string {
  return name.kind === 'server'
    ? t('localModels.serverName', { server: name.label, defaultValue: 'Your local server · {{server}}' })
    : t('localModels.deletedServer', { defaultValue: 'Deleted local server' });
}

/** The engine sentence of every local row. */
export function localEngineLine(t: TFunction): string {
  return t('localModels.engineLine', { defaultValue: 'On your own server; no Anthropic account is used' });
}

/** The heading of one server's block. */
export function localBlockHeading(t: TFunction, serverLabel: string): string {
  return t('localModels.blockHeading', { server: serverLabel, defaultValue: 'Local models · {{server}}' });
}
