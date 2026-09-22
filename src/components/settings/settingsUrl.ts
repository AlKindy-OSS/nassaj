import type { AgentCategory, AgentProvider, SettingsDeepLink, SettingsMainTab } from './types/types';

const MAIN_TABS = new Set<SettingsMainTab>([
  'profile', 'agents', 'references', 'vendors', 'appearance', 'git', 'api',
  'connectors', 'notifications', 'users', 'command-board', 'about',
]);

const AGENTS = new Set<AgentProvider>([
  'claude', 'cursor', 'codex', 'gemini', 'antigravity', 'opencode', 'qwen',
  'kimi', 'deepseek', 'glm', 'hermes', 'sakana',
]);

const CATEGORIES = new Set<AgentCategory>([
  'account', 'permissions', 'engines', 'instructions', 'mcp', 'skills',
]);

const writeSearch = (url: URL, replace: boolean) => {
  window.history[replace ? 'replaceState' : 'pushState'](null, '', `${url.pathname}${url.search}${url.hash}`);
};

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
  if (destination.tab === 'agents' && agent && AGENTS.has(agent as AgentProvider)) {
    destination.agent = agent as AgentProvider;
  }
  if (destination.tab === 'agents' && category && CATEGORIES.has(category as AgentCategory)) {
    destination.category = category as AgentCategory;
  }
  // ?settingsLocalModels=true selects the local-models card in the agents grid.
  if (destination.tab === 'agents' && params.get('settingsLocalModels') === 'true') {
    destination.localModels = true;
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
  if (destination.tab === 'agents') {
    if (destination.localModels) {
      url.searchParams.set('settingsLocalModels', 'true');
    } else {
      if (destination.agent) url.searchParams.set('settingsAgent', destination.agent);
      if (destination.category) url.searchParams.set('settingsCategory', destination.category);
    }
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
  writeSearch(url, false);
}

/** Role gate for URL destinations that otherwise render no settings surface. */
export function canOpenSettingsTab(tab: SettingsMainTab, role?: string): boolean {
  if (tab === 'users') return role === 'owner' || role === 'admin';
  if (tab === 'command-board') return role === 'owner';
  return true;
}
