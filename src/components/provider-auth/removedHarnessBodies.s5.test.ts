/**
 * ADR-229 S5 (client): the Kimi, Qwen Code and Hermes BODIES are gone from the
 * client — no name tile, billing link, MCP/skills panel, progress row, body
 * dispatch, ready prompt or login title. What stays: the Kimi engine inside
 * Claude (`kimi` engine slot + Moonshot key), and `qwen-plan/*` models with the
 * Coding Plan key inside OpenCode.
 *
 * RUNNER: vitest (`npm run test:client`).
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getProgressCapability } from '../chat/constants/providerCapabilities';
import { canReconcileOutboxHistory } from '../chat/utils/messageOutbox';
import { rowsForBody } from '../chat/view/subcomponents/modelPickerRows';
import { MCP_PROVIDER_NAMES, MCP_SUPPORTED_SCOPES } from '../mcp/constants';
import { AGENT_NAMES } from '../settings/view/tabs/agents-settings/sections/AgentSelectorSection';
import { BILLING_LINKS } from '../settings/view/tabs/agents-settings/sections/content/billingLinks';
import { readSettingsDestination } from '../settings/settingsUrl';
import { PROVIDER_NAMES } from '../skills/constants';
import { PROVIDER_FALLBACK_MODELS as FALLBACK_MODELS } from '../../constants/providerModelFallbacks';

const REMOVED = ['kimi', 'qwen', 'hermes'] as const;
const LOCALES = path.resolve(process.cwd(), 'src/i18n/locales');
const BODY_ONLY_KEYS: Record<string, string[]> = {
  'chat.json': ['messageTypes.kimi', 'providerSelection.readyPrompt.kimi'],
  'settings.json': [
    'agents.instructionSources.mechanism.kimi-agents',
    'providerLogin.title.kimi', 'providerLogin.title.hermes', 'providerLogin.title.qwen',
  ],
};
const ENGINE_KEYS: Record<string, string[]> = {
  'settings.json': ['engines.cell.claudeKimi', 'vendors.consumer.kimiEngineOnClaude'],
};
const lookup = (tree: unknown, key: string): unknown => key.split('.')
  .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
const readLocale = (locale: string, file: string): unknown => {
  const full = path.join(LOCALES, locale, file);
  try { return JSON.parse(readFileSync(full, 'utf8')); } catch { return {}; }
};

describe('removed harness bodies are gone from the client (ADR-229 S5)', () => {
  it.each(REMOVED)('%s has no settings tile, billing link, MCP or skills entry', (id) => {
    expect(Object.keys(AGENT_NAMES)).not.toContain(id);
    expect(Object.keys(BILLING_LINKS)).not.toContain(id);
    expect(Object.keys(MCP_PROVIDER_NAMES)).not.toContain(id);
    expect(Object.keys(MCP_SUPPORTED_SCOPES)).not.toContain(id);
    expect(Object.keys(PROVIDER_NAMES)).not.toContain(id);
  });

  it.each(REMOVED)('a settings deep link naming %s falls back to the default agent', (id) => {
    expect(readSettingsDestination(`?settings=agents&settingsAgent=${id}`)).toEqual({ tab: 'agents' });
  });

  it.each(REMOVED)('%s has no outbox history reconciliation of its own', (id) => {
    expect(canReconcileOutboxHistory({
      intent: { provider: id }, historyEligibility: 'text_only', imageNames: [], fileNames: [],
    } as never)).toBe(false);
  });

  it('a removed body has no own progress row', () => {
    expect(getProgressCapability('kimi')).toEqual({ plan: 'none', subagents: 'none' });
  });

  it('body-only strings are removed from every locale', () => {
    for (const locale of readdirSync(LOCALES)) {
      for (const [file, keys] of Object.entries(BODY_ONLY_KEYS)) {
        const tree = readLocale(locale, file);
        for (const key of keys) expect(lookup(tree, key), `${locale}/${file} ${key}`).toBeUndefined();
      }
    }
  });

  it('engine and key strings stay in English and Arabic', () => {
    for (const locale of ['en', 'ar']) {
      for (const [file, keys] of Object.entries(ENGINE_KEYS)) {
        for (const key of keys) expect(lookup(readLocale(locale, file), key), `${locale} ${key}`).toBeTruthy();
      }
    }
  });
});

describe('the engines that stay (ADR-229 S5)', () => {
  it('kimi-k3 stays selectable as a Claude engine once a Moonshot key is linked', () => {
    const catalog = { ...FALLBACK_MODELS };
    const rows = rowsForBody('claude', catalog, { kimi: true });
    const kimi = rows.filter((row) => row.engineProvider === 'kimi');
    expect(kimi.map((row) => row.model)).toContain('kimi-k3');
    expect(kimi.every((row) => !row.locked)).toBe(true);
  });

  it('qwen-plan models stay under OpenCode once the Coding Plan key is linked', () => {
    const catalog = { opencode: { OPTIONS: [{ value: 'qwen-plan/qwen3-coder-plus', label: 'Qwen3 Coder Plus' }], DEFAULT: 'qwen-plan/qwen3-coder-plus' } };
    expect(rowsForBody('opencode', catalog, { qwen: true }).map((row) => row.model)).toEqual(['qwen-plan/qwen3-coder-plus']);
    expect(rowsForBody('opencode', catalog, { qwen: false })).toEqual([]);
  });

  it('no picker row claims a removed Kimi Code subscription or a Nous/Hermes engine', () => {
    for (const body of REMOVED) {
      const rows = rowsForBody(body, { [body]: { OPTIONS: [{ value: 'm', label: 'm' }], DEFAULT: 'm' } },
        {}, { [body]: 'subscription_oauth' });
      const text = JSON.stringify(rows.map((row) => row.engine));
      expect(text).not.toContain('Kimi Code');
      expect(text).not.toContain('Nous');
      expect(text).not.toContain('"native"');
    }
  });
});
