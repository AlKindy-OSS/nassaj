/**
 * Agent terminology guard (B-1740).
 *
 * The programs Nassaj runs (Claude Code, Codex CLI, OpenCode, Antigravity,
 * Kimi CLI, DeepSeek Harness…) are "coding agents" / «وكلاء برمجيون»; the
 * company that serves the model over an API and bills for it stays the
 * "model provider" / «مزوّد النموذج». "Harness" is an internal word and never a
 * UI label, and the Arabic coinages «جسد/أجساد/الجسم/جسمان» are retired.
 *
 *   1. No Arabic value anywhere uses the retired «جسد» family.
 *   2. No English value anywhere says "harness" (the product name
 *      "DeepSeek Harness" excepted) or calls an agent a "Claude/model body".
 *   3. The curated keys below name the coding-agent programs; in every locale
 *      that ships them, the value must not call those programs a provider,
 *      harness, engine, or body.
 *
 * `{{placeholders}}` are stripped before matching: `{{provider}}` is a code
 * identifier that the UI fills with a display name.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOCALES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'locales');

type Flat = Record<string, string>;

const flatten = (value: unknown, prefix = '', out: Flat = {}): Flat => {
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (entry && typeof entry === 'object') flatten(entry, full, out);
    else out[full] = String(entry);
  }
  return out;
};

const load = (locale: string, namespace: string): Flat | null => {
  const file = path.join(LOCALES, locale, `${namespace}.json`);
  return existsSync(file) ? flatten(JSON.parse(readFileSync(file, 'utf8'))) : null;
};

const namespacesOf = (locale: string): string[] => readdirSync(path.join(LOCALES, locale))
  .filter((name) => name.endsWith('.json'))
  .map((name) => name.replace(/\.json$/, ''));

const stripPlaceholders = (value: string) => value.replace(/\{\{[^}]*\}\}/g, '');

/** Keys whose values name the coding-agent programs themselves. */
const AGENT_KEYS: Record<string, string[]> = {
  chat: [
    'skillObservations.unsupported',
    'messageFork.errors.unsupported_provider',
    'contextRot.cache.unknown',
    'sessionNotResumable.message',
    'providerSelection.description',
    'providerSelection.readyPrompt.default',
    'providerSelection.readyPrompt.claudeEngine',
    'providerSelection.providerUnavailable',
    'providerSelection.engineOnVendor',
    'agentActivity.stoppedTooltip',
    'participants.harnessLine',
    'outbox.reason.effect_scope_fenced_provider',
    'commandResult.models.allProviders',
    'commandResult.models.fallbackCatalog',
    'commandResult.models.refreshAll',
    'commandResult.status.rows.provider',
    'commandResult.cost.provider',
    'commandResult.meta.models.subtitle',
    'commandResult.meta.status.subtitle',
    'steer.errors.steer_unsupported',
    'shellMode.disabledReason.provider_removed',
    'localModels.blocked.model_id_reserved',
    'serverError.permission_auto_rejected',
    'coordinationLevel.enforcement.mechanical',
    'coordinationLevel.enforcement.textual',
    'coordinationLevel.enforcement.none',
    'coordinationLevel.levels.delegate_review.description',
  ],
  settings: [
    'harnessVersion.title',
    'harnessVersion.noCli',
    'harnessAutoUpdate.description',
    'claudeUsage.notApplicable',
    'mcpForm.scope.option.projectAll',
    'mcpForm.scope.option.userAll',
    'mcpForm.scope.hint.projectAll',
    'mcpForm.scope.hint.userAll',
    'mcpForm.validation.unsupportedTransport',
    'mcpServers.addGlobal.description',
    'mcpServers.addGlobal.modalDescription',
    'engines.cell.claudeZen',
    'subscriptions.harnessTotal',
    'vendors.link.error.vendorWide',
    'vendors.link.delete.fixedLine',
    'vendors.restore.title',
    'connectorsSettings.description',
    'connectorsSettings.m5.states.saved_inactive.detail',
    'connectorsSettings.unsupportedNote',
    'connectorsSettings.oauthLinked',
    'connectorsSettings.toolsByEngine',
    'connectorsSettings.placement.partial',
    'connectorsSettings.placementNote.partial',
    'harnessFiles.title',
    'harnessFiles.loading',
    'harnessFiles.loadFailed',
    'engines.cell.claudeLocalForbidden',
    'engines.usageHint',
    'references.scope.no-channel',
    'references.fields.engine',
    'references.reason.no_mechanism',
    'references.error.providerUnavailable',
    'references.instructions.description',
    'references.skills.description',
    'references.governance.description',
    'agents.instructionSources.reason.no_mechanism',
    'agents.instructionSources.reason.copy_missing',
    'agents.instructionSources.reason.copy_empty',
    'storagePolicy.retentionHint',
  ],
  common: ['governanceBadge.tooltip.none'],
};

/** Per-locale words that, inside an AGENT_KEYS value, misname the agent. */
const MISNAMES: Record<string, RegExp> = {
  en: /\b(providers?|harness(es)?|engines?|body|bodies)\b/i,
  ar: /مزو|مورّد|جسد|أجساد|الجسم|جسمان|محرّك|المحرك|المشغّل|الهارنس|أداة التشغيل/,
  de: /Anbieter|Harness|Engine/i,
  it: /\bprovider\b|harness|motore/i,
  ja: /プロバイダ|ハーネス|エンジン/,
  ko: /프로바이더|제공자|하네스|엔진/,
  ru: /провайдер|оболочк|харнесс|движ/i,
  tr: /sağlayıcı|harness|motor/i,
  'zh-CN': /提供商|供应商|提供者|提供方|载体|运行环境|引擎/,
  fa: /تأمین‌کننده|ارائه‌دهنده/,
  id: /penyedia/i,
  ur: /فراہم کنندہ/,
};

const LOCALE_DIRS = readdirSync(LOCALES).filter((name) => !name.includes('.'));

test('no Arabic value uses the retired «جسد» coinage', () => {
  // «جسم الطلب» (an HTTP request body) is legitimate; only the agent sense is retired.
  const retired = /جسد|أجساد|جسمان|الهارنس|أجسام|(ال)?جسم\s*(Claude|النموذج|النماذج|الوكيل)/;
  const hits = namespacesOf('ar').flatMap((namespace) => Object.entries(load('ar', namespace) ?? {})
    .filter(([, value]) => retired.test(value))
    .map(([key, value]) => `${namespace}:${key} = ${value}`));
  assert.deepEqual(hits, []);
});

test('no English value calls an agent or model a "body"', () => {
  const hits = namespacesOf('en').flatMap((namespace) => Object.entries(load('en', namespace) ?? {})
    .filter(([, value]) => /\b(Claude|model|non-Claude)\s+bod(y|ies)\b/i.test(stripPlaceholders(value)))
    .map(([key, value]) => `${namespace}:${key} = ${value}`));
  assert.deepEqual(hits, []);
});

test('no English value says "harness" except the DeepSeek Harness product name', () => {
  const hits = namespacesOf('en').flatMap((namespace) => Object.entries(load('en', namespace) ?? {})
    .filter(([, value]) => /harness/i.test(stripPlaceholders(value).replace(/DeepSeek Harness/g, '')))
    .map(([key, value]) => `${namespace}:${key} = ${value}`));
  assert.deepEqual(hits, []);
});

test('every locale has a misname pattern', () => {
  assert.deepEqual(LOCALE_DIRS.filter((locale) => !MISNAMES[locale]), []);
});

test('curated coding-agent keys exist in en and ar', () => {
  const missing = ['en', 'ar'].flatMap((locale) => Object.entries(AGENT_KEYS)
    .flatMap(([namespace, keys]) => keys
      .filter((key) => load(locale, namespace)?.[key] === undefined)
      .map((key) => `${locale}/${namespace}:${key}`)));
  assert.deepEqual(missing, []);
});

test('coding-agent keys do not call the agent a provider, harness, engine or body', () => {
  const hits = LOCALE_DIRS.flatMap((locale) => Object.entries(AGENT_KEYS)
    .flatMap(([namespace, keys]) => {
      const values = load(locale, namespace);
      if (!values) return [];
      return keys
        .filter((key) => values[key] !== undefined)
        .filter((key) => MISNAMES[locale].test(stripPlaceholders(values[key]).replace(/DeepSeek Harness/g, '')))
        .map((key) => `${locale}/${namespace}:${key} = ${values[key]}`);
    }));
  assert.deepEqual(hits, []);
});
