/**
 * provider-credential-files — ONE table of the credential files a member's
 * isolated tree holds, per provider, and the pure reader that turns a file into
 * a value-free health snapshot (B-1771).
 *
 * Each row's `dir` mirrors where resolveProviderEnv points that provider for a
 * member's own tree (parity: provider-credential-files.test.ts). Rows are data:
 * presence fields are JSON paths (`*` = any key), `completeWhen` lists field
 * groups of which one must be fully present, and `classifier` names an existing
 * classifier to reuse instead of the shape rule. A snapshot never carries a
 * credential value or any part of one, only booleans, mtime and size.
 *
 * Coverage (parity: provider-credential-files.test.ts): every provider of
 * KNOWN_PROVIDERS is `provider` or in `covers` of some row. Vendor-key slots
 * (glm, deepseek, dsh, qwen, kimi) keep their keys in the member's encrypted
 * provider-secrets store; its row reports which vendor entries are present,
 * never a ciphertext. hermes (T-1953) and the kimi native CLI (ADR-229) are
 * `legacy`: their bodies are removed, but their credential files still sit in
 * member trees, so a write to one is still recorded.
 */
import fs from 'node:fs';

import { classifyOauthLink } from '@/modules/providers/list/claude/claude-auth.provider.js';
import { resolveCodexEffectiveAuth } from '@/modules/providers/list/codex/codex-auth.provider.js';
import { KIMI_HOME_SUBDIR } from '@/services/isolation/provision-user-dirs.js';
import { readObjectRecord } from '@/shared/utils.js';

/** A presence field: a JSON path, or a path whose array must include one of `includesAny`. */
export type CredentialFieldSpec = string | { path: string; includesAny: readonly string[] };

export type CredentialClassifierName = 'claude-oauth' | 'codex-auth';

export type CredentialFileSpec = {
  provider: string;
  /** Subpath of the member root (`~/.nassaj-users/<id>/<dir>`). */
  dir: string;
  file: string;
  fields: Readonly<Record<string, CredentialFieldSpec>>;
  /** Shape rule: complete when every field of at least one group is present. */
  completeWhen: ReadonlyArray<ReadonlyArray<string>>;
  classifier?: CredentialClassifierName;
  /** Providers whose credential this file holds when not just `provider`. */
  covers?: readonly string[];
  /** A provider with no isolation body any more whose file still exists. */
  legacy?: boolean;
};

export const PROVIDER_CREDENTIAL_FILES: ReadonlyArray<CredentialFileSpec> = Object.freeze<CredentialFileSpec[]>([
  {
    provider: 'claude',
    dir: '.claude',
    file: '.credentials.json',
    fields: {
      accessToken: 'claudeAiOauth.accessToken',
      refreshToken: 'claudeAiOauth.refreshToken',
      profileScope: { path: 'claudeAiOauth.scopes', includesAny: ['profile', 'user:profile'] },
      expiresAt: 'claudeAiOauth.expiresAt',
    },
    completeWhen: [['accessToken', 'refreshToken']],
    classifier: 'claude-oauth',
  },
  {
    provider: 'codex',
    dir: '.codex',
    file: 'auth.json',
    fields: {
      apiKey: 'OPENAI_API_KEY',
      accessToken: 'tokens.access_token',
      refreshToken: 'tokens.refresh_token',
      idToken: 'tokens.id_token',
    },
    completeWhen: [['apiKey'], ['accessToken', 'refreshToken']],
    classifier: 'codex-auth',
  },
  {
    provider: 'opencode',
    dir: '.local/share/opencode',
    file: 'auth.json',
    fields: { apiKey: '*.key', accessToken: '*.access', refreshToken: '*.refresh' },
    completeWhen: [['apiKey'], ['accessToken', 'refreshToken']],
  },
  {
    provider: 'kimi',
    dir: `${KIMI_HOME_SUBDIR}/credentials`,
    file: 'kimi-code.json',
    fields: { accessToken: 'access_token', refreshToken: 'refresh_token', expiresAt: 'expires_at' },
    completeWhen: [['accessToken', 'expiresAt']],
    // ADR-229: the native kimi CLI body is removed; kimi stays a key slot
    // (provider-secrets row below). The file stays watched, like hermes.
    legacy: true,
  },
  {
    provider: 'agy',
    dir: '.gemini/antigravity-cli',
    file: 'antigravity-oauth-token',
    fields: { accessToken: 'token.access_token', refreshToken: 'token.refresh_token', expiresAt: 'token.expiry' },
    completeWhen: [['accessToken', 'refreshToken']],
  },
  {
    provider: 'cursor',
    dir: '.config/cursor',
    file: 'auth.json',
    fields: { accessToken: 'accessToken', refreshToken: 'refreshToken' },
    completeWhen: [['accessToken', 'refreshToken']],
  },
  {
    provider: 'provider-secrets',
    dir: '.provider-secrets',
    file: 'keys.json',
    fields: { glm: 'glm', kimi: 'kimi', deepseek: 'deepseek', qwen: 'qwen' },
    completeWhen: [['glm'], ['kimi'], ['deepseek'], ['qwen']],
    covers: ['glm', 'kimi', 'deepseek', 'dsh', 'qwen'],
  },
  {
    provider: 'hermes',
    dir: '.hermes',
    file: 'auth.json',
    fields: { accessToken: 'providers.*.access_token', refreshToken: 'providers.*.refresh_token' },
    completeWhen: [['accessToken', 'refreshToken']],
    legacy: true,
  },
]);

/** Every provider whose credential some row observes. */
export function watchedProviders(specs: ReadonlyArray<CredentialFileSpec> = PROVIDER_CREDENTIAL_FILES): Set<string> {
  return new Set(specs.flatMap((spec) => [spec.provider, ...(spec.covers ?? [])]));
}

/** States a provider counts as healthy; leaving one of them is a degrade. */
const HEALTHY_STATES: Readonly<Record<string, ReadonlySet<string>>> = {
  'claude-oauth': new Set(['linked']),
  'codex-auth': new Set(['api_key', 'subscription']),
  shape: new Set(['complete']),
};

export type CredentialFileSnapshot = {
  exists: boolean;
  mtimeMs: number | null;
  size: number | null;
  fields: Record<string, boolean>;
  /** missing | malformed | classifier result | complete | incomplete | empty */
  state: string;
};

/** Files above this size are not credential files; they are reported malformed unread. */
const MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024;

function present(value: unknown): boolean {
  if (typeof value === 'string') return value.length > 0;
  return value !== undefined && value !== null && value !== false;
}

/** Values at a dotted path; `*` fans out over an object's own values. */
function valuesAt(root: unknown, dotted: string): unknown[] {
  let current: unknown[] = [root];
  for (const segment of dotted.split('.')) {
    const next: unknown[] = [];
    for (const node of current) {
      const record = readObjectRecord(node);
      if (!record) continue;
      if (segment === '*') next.push(...Object.values(record));
      else if (Object.hasOwn(record, segment)) next.push(record[segment]);
    }
    current = next;
  }
  return current;
}

function fieldPresent(root: unknown, spec: CredentialFieldSpec): boolean {
  if (typeof spec === 'string') return valuesAt(root, spec).some(present);
  return valuesAt(root, spec.path).some((value) => Array.isArray(value)
    && value.some((item) => typeof item === 'string' && spec.includesAny.includes(item)));
}

function classify(spec: CredentialFileSpec, data: Record<string, unknown>, fields: Record<string, boolean>, now: number): string {
  if (spec.classifier === 'claude-oauth') return classifyOauthLink(readObjectRecord(data.claudeAiOauth), now);
  if (spec.classifier === 'codex-auth') return resolveCodexEffectiveAuth(data);
  if (!Object.values(fields).some(Boolean)) return 'empty';
  return spec.completeWhen.some((group) => group.every((name) => fields[name])) ? 'complete' : 'incomplete';
}

/**
 * Reads one credential file into a value-free snapshot. Never throws and never
 * writes: a missing file is `missing`, unreadable or non-object JSON is `malformed`.
 */
export function readCredentialFileSnapshot(spec: CredentialFileSpec, filePath: string, now = Date.now()): CredentialFileSnapshot {
  const fields = Object.fromEntries(Object.keys(spec.fields).map((name) => [name, false]));
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { exists: false, mtimeMs: null, size: null, fields, state: 'missing' };
  }
  const base = { exists: true, mtimeMs: stat.mtimeMs, size: stat.size, fields };
  if (!stat.isFile() || stat.size > MAX_CREDENTIAL_FILE_BYTES) return { ...base, state: 'malformed' };
  let data: Record<string, unknown> | null;
  try {
    data = readObjectRecord(JSON.parse(fs.readFileSync(filePath, 'utf8'))) ?? null;
  } catch {
    data = null;
  }
  if (!data) return { ...base, state: 'malformed' };
  for (const [name, fieldSpec] of Object.entries(spec.fields)) fields[name] = fieldPresent(data, fieldSpec);
  return { ...base, state: classify(spec, data, fields, now) };
}

/** True when moving from `previous` to `current` leaves a healthy state. */
export function isCredentialDegrade(spec: CredentialFileSpec, previous: string | null, current: string): boolean {
  const healthy = HEALTHY_STATES[spec.classifier ?? 'shape'];
  return previous !== null && healthy.has(previous) && !healthy.has(current);
}

/** Presence fields that were present in `previous` and are gone in `current`. */
export function lostFields(previous: CredentialFileSnapshot, current: CredentialFileSnapshot): string[] {
  return Object.keys(previous.fields).filter((name) => previous.fields[name] && !current.fields[name]);
}
