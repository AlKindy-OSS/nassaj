import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const ROOT = process.cwd();
const CALL = /\b(?:getChangedActiveModel|writeProviderSessionActiveModelChange|removeProviderSessionActiveModelChange|setSessionEnginePin|getSessionEnginePin)\s*\(/;
const EXPECTED = new Set([
  'server/agy-cli.js', 'server/opencode-cli.js', 'server/claude-sdk.js',
  'server/services/isolation/resolve-claude-run-profile.js',
  'server/modules/providers/provider.routes.ts',
  'server/modules/providers/shared/vendor/vendor-models.provider.ts',
  'server/modules/providers/services/provider-models.service.ts',
  'server/modules/providers/list/antigravity/antigravity-models.provider.ts',
  'server/modules/providers/list/cursor/cursor-models.provider.ts',
  'server/modules/providers/list/claude/claude-models.provider.ts',
  'server/modules/providers/list/codex/codex-models.provider.ts',
  'server/modules/providers/list/opencode/opencode-models.provider.ts',
  // ADR-227 (T-2098): read-only getSessionEnginePin, so a local-pinned conversation
  // is refused at spawn sites that cannot run a local engine; they never write a pin.
  'server/modules/turn-supervisor/hosted-turn-supervisor.service.ts',
  'server/modules/workflow-supervisor/launch.route.ts',
  'server/modules/workflow-supervisor/supervisor.ts',
  // T-2087 context guard: read-only (getChangedActiveModel / getSessionEnginePin).
  'server/modules/context-guard/index.ts',
  'server/modules/context-guard/claude-compaction-model.ts',
  // ADR-227 local engines (T-2103, T-2107, T-2108), recorded late here: read-only
  // getSessionEnginePin in the cost book and the Codex terminal refusal, a read-only
  // getChangedActiveModel in the Codex local run, and the strict local-pin writer that
  // goes through the single sessionsDb.setSessionEnginePin writer (ADR-088).
  'server/modules/providers/services/cost/local-engine-usage.ts',
  'server/modules/websocket/services/shell-websocket.service.ts',
  'server/openai-codex.js',
  'server/services/isolation/local-engine-pin-writer.js',
]);
const APP_CONFIG_WRITERS = new Set([
  'server/modules/database/migrations.ts',
  // ADR-152 A1 §3.2 (T-2083): deletes the retired provider-sharing key, once.
  'server/modules/database/provider-sharing-retirement.migration.ts',
  'server/modules/database/repositories/app-config.ts',
  'server/modules/database/repositories/engine-restamp-intent.db.ts',
  // T-1946: the API key SSO window (key 'api_keys.sso_attestation_window_days').
  'server/modules/database/repositories/api-key-sso-window.ts',
  // ADR-203 (T-2003 C1): the 'harness_files.allow_member_private' switch only,
  // a fixed parameterized key; never the reserved engine_restamp namespace.
  'server/modules/database/repositories/harness-files-mode.db.ts',
  // ADR-194 (T-1962): 'sso.disabled' and 'installation.origin' only; never the
  // reserved engine_restamp namespace (the next test still enforces that).
  'server/modules/database/repositories/sso-oidc-config.ts',
  'server/modules/database/sso-oidc-config.migration.ts',
  'server/services/installation-origin.service.js',
  // ADR-H20 S6: upserts/deletes only the five fixed 'sso.linked.*' keys
  // (SSO_LINKED_KEYS) with bound parameters; never the engine_restamp namespace.
  'server/modules/database/repositories/sso-linked-settings.ts',
  // T-1962 test fixtures (not *.test.* files, so the glob sees them).
  'server/routes/__tests__/settings-sso-harness.ts',
  'server/services/__tests__/sso-config-fixture.ts',
]);
const RESERVED_NAMESPACE_WRITERS = new Set([
  'server/modules/database/repositories/engine-restamp-intent.db.ts',
  'server/modules/database/repositories/engine-restamp-intent.test-harness.ts',
]);

test('engine pin and active-model production call sites remain exactly inventoried', () => {
  const files = fs.globSync('server/**/*.{ts,js}', { cwd: ROOT }).filter((file) =>
    !file.includes('.test.') && file !== 'server/modules/database/repositories/sessions.db.ts'
    && file !== 'server/shared/utils.ts');
  const actual = new Set(files.filter((file) => CALL.test(fs.readFileSync(path.join(ROOT, file), 'utf8'))));
  assert.deepEqual([...actual].sort(), [...EXPECTED].sort());
});

test('every production app_config SQL writer remains explicitly inventoried', () => {
  const writers = fs.globSync('server/**/*.{ts,js}', { cwd: ROOT }).filter((file) => {
    if (file.includes('.test.') || file.includes('.test-harness.')) return false;
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    return /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+app_config/i.test(source);
  });
  assert.deepEqual(writers.sort(), [...APP_CONFIG_WRITERS].sort());
});

test('reserved namespace SQL writers include only the strict repository and named harness', () => {
  const writers = fs.globSync('server/**/*.{ts,js}', { cwd: ROOT }).filter((file) => {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const namesReservedNamespace = source.includes('ENGINE_RESTAMP_INTENT_PREFIX')
      || source.includes('engine_restamp.v1:');
    return namesReservedNamespace
      && /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+app_config/i.test(source);
  });
  assert.deepEqual(writers.sort(), [...RESERVED_NAMESPACE_WRITERS].sort());
});
