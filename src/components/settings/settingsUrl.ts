import { isProviderGloballyDisabled } from '../../../shared/disabledProviders';

import type { AgentCategory, AgentProvider, SettingsDeepLink, SettingsMainTab } from './types/types';

const MAIN_TABS = new Set<SettingsMainTab>([
  'profile', 'agents', 'references', 'vendors', 'appearance', 'git', 'api',
  'connectors', 'notifications', 'users', 'command-board', 'system', 'about',
]);

/**
 * The full agent union, for upstream-sync friendliness — kept complete even
 * though `isAgentDeepLinkable` below rejects the globally disabled ids
 * (T-864/T-1906): a deep link naming `qwen` or `hermes` must fall back to the
 * default agent rather than pin a hidden one that renders no category
 * content.
 */
const AGENTS = new Set<AgentProvider>([
  'claude', 'cursor', 'codex', 'antigravity', 'opencode', 'qwen',
  'kimi', 'deepseek', 'glm', 'hermes', 'sakana',
]);

/** A deep-linkable agent: known to the union AND not globally disabled. */
function isAgentDeepLinkable(agent: string): agent is AgentProvider {
  return AGENTS.has(agent as AgentProvider) && !isProviderGloballyDisabled(agent);
}

const CATEGORIES = new Set<AgentCategory>([
  'account', 'permissions', 'engines', 'instructions', 'mcp', 'skills',
]);

const writeSearch = (url: URL, replace: boolean) => {
  window.history[replace ? 'replaceState' : 'pushState'](null, '', `${url.pathname}${url.search}${url.hash}`);
};

/**
 * B-1076 — محدِّد حجب صلاحيةٍ بمعرّف جلسةٍ فقط: نمط UUID (v1–v5 فضفاضاً، يكفي
 * لمنع الحقن) وسقف طول 64 حرفاً. أي قيمة أخرى (`<script>`, `javascript:`,
 * نصّ عشوائي طويل) تُرفض بصمت — رابطٌ مُشارَك مشوَّه يفتح تبويب «النظام» غير
 * مفلتَر بدل أن يُدرَج نصّه في الصفحة أو في رابطٍ.
 *
 * مُصدَّر لأن `PermissionFencesSection.tsx` يطبّق النمط نفسه على الفلترة
 * المعروضة — نسخة واحدة، لا نسختان قد تنفرجان (درس «منطق مكرَّر يحتاج حارس
 * تطابق»).
 */
export const FENCE_FILTER_PATTERN = /^[0-9a-zA-Z_-]{1,64}$/;

function sanitizeFenceFilter(value: string | null): string | undefined {
  return value && FENCE_FILTER_PATTERN.test(value) ? value : undefined;
}

/** Reads only recognized settings parameters so malformed shared links stay harmless. */
export function readSettingsDestination(search = window.location.search): SettingsDeepLink | undefined {
  const params = new URLSearchParams(search);
  const tab = params.get('settings');
  if (!tab) return undefined;

  // Legacy redirect: ?settings=local-models → agents tab with local-models card selected.
  if (tab === 'local-models') return { tab: 'agents', localModels: true };

  if (!MAIN_TABS.has(tab as SettingsMainTab)) return undefined;

  const destination: SettingsDeepLink = { tab: tab as SettingsMainTab };
  const agent = params.get('settingsAgent');
  const category = params.get('settingsCategory');
  if (destination.tab === 'agents' && agent && isAgentDeepLinkable(agent)) {
    destination.agent = agent;
  }
  if (destination.tab === 'agents' && category && CATEGORIES.has(category as AgentCategory)) {
    destination.category = category as AgentCategory;
  }
  // ?settingsLocalModels=true selects the local-models card in the agents grid.
  if (destination.tab === 'agents' && params.get('settingsLocalModels') === 'true') {
    destination.localModels = true;
  }
  if (destination.tab === 'system') {
    const fenceFilter = sanitizeFenceFilter(params.get('settingsFenceFilter'));
    if (fenceFilter) destination.fenceFilter = fenceFilter;
  }
  return destination;
}

/** Keeps a shareable settings destination in the domain without changing the app route. */
export function writeSettingsDestination(destination: SettingsDeepLink, options: { replace?: boolean } = {}): void {
  const url = new URL(window.location.href);
  url.searchParams.set('settings', destination.tab);
  url.searchParams.delete('settingsAgent');
  url.searchParams.delete('settingsCategory');
  url.searchParams.delete('settingsLocalModels');
  url.searchParams.delete('settingsFenceFilter');
  if (destination.tab === 'agents') {
    if (destination.localModels) {
      url.searchParams.set('settingsLocalModels', 'true');
    } else {
      if (destination.agent) url.searchParams.set('settingsAgent', destination.agent);
      if (destination.category) url.searchParams.set('settingsCategory', destination.category);
    }
  }
  if (destination.tab === 'system') {
    const fenceFilter = sanitizeFenceFilter(destination.fenceFilter ?? null);
    if (fenceFilter) url.searchParams.set('settingsFenceFilter', fenceFilter);
  }
  writeSearch(url, Boolean(options.replace));
}

/** Removes the modal-only settings route state while retaining unrelated query parameters. */
export function clearSettingsDestination(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('settings');
  url.searchParams.delete('settingsAgent');
  url.searchParams.delete('settingsCategory');
  url.searchParams.delete('settingsLocalModels');
  url.searchParams.delete('settingsFenceFilter');
  writeSearch(url, false);
}

/** Role gate for URL destinations that otherwise render no settings surface. */
export function canOpenSettingsTab(tab: SettingsMainTab, role?: string): boolean {
  if (tab === 'users') return role === 'owner' || role === 'admin';
  if (tab === 'command-board') return role === 'owner';
  if (tab === 'system') return role === 'owner';
  return true;
}
