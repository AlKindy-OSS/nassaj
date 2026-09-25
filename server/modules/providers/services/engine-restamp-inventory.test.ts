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
  'server/modules/providers/list/gemini/gemini-models.provider.ts',
  'server/modules/providers/list/qwen/qwen.provider.ts',
]);
const APP_CONFIG_WRITERS = new Set([
  'server/modules/database/migrations.ts',
  'server/modules/database/repositories/app-config.ts',
  'server/modules/database/repositories/engine-restamp-intent.db.ts',
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
