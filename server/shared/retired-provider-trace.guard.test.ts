/**
 * T-1853 — the single static guard over the deleted Gemini CLI provider, for the
 * server AND the client (it replaces src/geminiRemovalGuard.test.ts).
 *
 * Every file under server/, shared/, src/, public/, scripts/ and docs/team-wiki/ (plus
 * .env.example) whose content matches /gemini/i must be
 * listed below with the reason it legitimately keeps the word. The word is NOT
 * the provider in any of them: it is agy's credential unit (~/.gemini), agy's
 * governance file (GEMINI.md), Google's model family (gemini-*), a GEMINI_*
 * secret prefix, a colour theme named after the brand, or the typed refusal
 * for stale requests.
 *
 * Both directions fail:
 *  - a new file mentioning gemini (a leftover or a re-introduction) is unlisted;
 *  - a listed file that no longer mentions gemini is stale — which is exactly
 *    what a wrong grep-and-delete of an agy dependency looks like.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const SCANNED_ROOTS = ['server', 'shared', 'src', 'public', 'scripts', 'docs/team-wiki'];
const SCANNED_FILES = ['.env.example'];
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.artifacts', 'coverage']);
const PATTERN = /gemini/i;

const AGY_HOME = 'agy keeps its state and credential under ~/.gemini';
const AGY_MODELS = 'agy/Google gemini-* model names';
const AGY_GOVERNANCE = 'agy governance file GEMINI.md';
const THEME = "the 'gemini' colour theme preset, unrelated to the provider";
const CREDENTIAL_UNIT = "'gemini' is agy's credential unit (credential-principal.js)";

/** Relative path → one-line reason it keeps the word. */
const ALLOWLIST: Readonly<Record<string, string>> = Object.freeze({
  'server/agy-cli.js': AGY_HOME,
  'server/agy-cli.lifecycle.test.ts': AGY_HOME,
  'server/agy-cli.model.test.ts': AGY_MODELS,
  'server/agy-cli.registry-integration.test.ts': AGY_HOME,
  'server/agy-cli.stderr-surface.test.ts': 'recorded agy stderr for a Gemini model quota error',
  'server/agy-cli.utf8-chunk.test.ts': AGY_HOME,
  'server/modules/projects/services/codebase-stats.service.ts': 'stats skip .gemini dirs and GEMINI.md files',
  'server/modules/projects/tests/codebase-stats.service.test.ts': 'asserts .gemini is skipped by stats',
  'server/modules/providers/governance-preferences.routes.test.ts': AGY_GOVERNANCE,
  'server/modules/providers/list/antigravity/antigravity-auth.provider.ts': AGY_HOME,
  'server/modules/providers/list/antigravity/antigravity-mcp.provider.ts': 'agy MCP config is .gemini/config/mcp_config.json',
  'server/modules/providers/list/antigravity/antigravity-models-cli.client.ts': AGY_MODELS,
  'server/modules/providers/list/antigravity/antigravity-models.provider.ts': AGY_MODELS,
  'server/modules/providers/list/antigravity/antigravity-session-synchronizer.provider.ts': AGY_HOME,
  'server/modules/providers/list/antigravity/antigravity-token-reader.ts': AGY_HOME,
  'server/modules/providers/list/antigravity/__tests__/agy-failure-reason.test.ts': AGY_MODELS,
  'server/modules/providers/list/antigravity/__tests__/antigravity-auth.isolation.test.ts': AGY_HOME,
  'server/modules/providers/list/antigravity/__tests__/antigravity-auth.test.ts': AGY_HOME,
  'server/modules/providers/list/antigravity/__tests__/antigravity-catalog.test.ts': AGY_MODELS,
  'server/modules/providers/list/antigravity/__tests__/antigravity-mcp.provider.test.ts': AGY_HOME,
  'server/modules/providers/list/antigravity/__tests__/antigravity-models-cli.test.ts': AGY_MODELS,
  'server/modules/providers/list/antigravity/__tests__/antigravity-sync.test.ts': AGY_HOME,
  'server/modules/providers/list/cursor/cursor-models.provider.ts': 'Cursor offers Google gemini-* models',
  'server/modules/providers/list/opencode/glm-carrier.integration.test.ts': 'asserts GEMINI_API_KEY is stripped',
  'server/modules/providers/list/opencode/opencode-auth.provider.ts': 'OpenCode accepts a GEMINI_API_KEY for Google models',
  'server/modules/providers/list/opencode/opencode-models.provider.ts': 'OpenCode offers google/gemini-* models',
  'server/modules/providers/provider.routes.governance-link.test.ts': AGY_GOVERNANCE,
  'server/modules/providers/provider.routes.mcp-member-scope.test.ts': 'asserts nothing writes the legacy ~/.gemini/settings.json',
  'server/modules/providers/README.md': 'documents the agy MCP path under .gemini',
  'server/modules/providers/services/antigravity-active-model.service.ts': 'reads agy cli.log under ~/.gemini',
  'server/modules/providers/services/cost/cost-calculator.test.ts': 'prices a Google gemini-* model',
  'server/modules/providers/services/cost/model-pricing.ts': 'Google gemini-* model prices',
  'server/modules/providers/services/cost/model-vendor.test.ts': 'gemini-* models resolve to the google vendor',
  'server/modules/providers/services/cost/model-vendor.ts': 'gemini model prefix maps to the google vendor',
  'server/modules/providers/services/governance-preferences.integration.test.ts': AGY_GOVERNANCE,
  'server/modules/providers/services/mcp-placement.policy.ts': 'cleanup-only port for legacy ~/.gemini/settings.json entries',
  'server/modules/providers/services/mcp.service.ts': 'legacy .gemini/settings.json cleaner and agy MCP path',
  'server/modules/providers/services/provider-governance.service.test.ts': AGY_GOVERNANCE,
  'server/modules/providers/services/provider-governance.service.ts': 'agy gemini-md governance channel',
  'server/modules/providers/services/__tests__/antigravity-active-model.test.ts': AGY_MODELS,
  'server/modules/providers/tests/agy-gemini-unit.regression.test.ts': 'agy regression guard for this deletion',
  'server/modules/providers/tests/mcp.test.ts': 'legacy ~/.gemini/settings.json cleaner contract',
  'server/modules/reference-materials/reference-materials.routes.test.ts': 'asserts no gemini entry; agy GEMINI.md channel',
  'server/modules/reference-materials/reference-materials.service.ts': AGY_GOVERNANCE,
  'server/routes/credential-grants.test.ts': CREDENTIAL_UNIT,
  'server/routes/credential-grants.ts': CREDENTIAL_UNIT,
  'server/services/__fixtures__/b421-poisoned-transcript.jsonl': 'recorded transcript text (fixture data)',
  'server/services/isolation/agy-onboarding.service.js': AGY_HOME,
  'server/services/isolation/agy-onboarding.test.ts': AGY_HOME,
  'server/services/isolation/credential-principal.js': CREDENTIAL_UNIT,
  'server/services/isolation/gemini-governance-material.js': AGY_GOVERNANCE,
  'server/services/isolation/grant-home.js': 'grants link .gemini for the agy unit',
  'server/services/isolation/isolation.e2e.test.ts': CREDENTIAL_UNIT,
  'server/services/isolation/provider-cage-wiring.js': AGY_HOME,
  'server/services/isolation/provider-cage-wiring.test.ts': AGY_HOME,
  'server/services/isolation/provision-agy.test.ts': AGY_HOME,
  'server/services/isolation/provision-permissions.test.ts': 'per-user .gemini dir permissions',
  'server/services/isolation/provision-user-dirs.js': 'provisions per-user .gemini and GEMINI.md for agy',
  'server/services/isolation/resolve-provider-env.js': AGY_HOME,
  'server/services/isolation/sanitize-vendor-agent-env.js': 'strips GEMINI_* secrets from vendor agents',
  'server/services/isolation/sanitize-vendor-agent-env.test.js': 'asserts GEMINI_* handling',
  'server/services/isolation/vendor-single-launcher.guard.test.ts': 'asserts GEMINI_API_KEY is stripped',
  'server/services/transcript-parser.js': AGY_MODELS,
  'server/sessionManager.js': 'shared agy/kimi session store keeps the ~/.gemini/sessions path',
  'server/shared/retired-provider-trace.guard.test.ts': 'this guard',
  'shared/retiredProviders.ts': 'the one place the retired id is named, for typed refusals',
  'public/modelConstants.js': 'cursor/agy/opencode catalogs list Google gemini-* models',
  'src/components/chat/hooks/useProviderGovernance.ts': 'agy gemini-md governance mechanism id',
  'src/components/chat/view/subcomponents/MessageModelBadge.test.tsx': 'badge label for a Google gemini-* model',
  'src/components/provider-auth/providerSelectionEmptyState.antigravityRows.test.tsx': AGY_MODELS,
  'src/components/settings/hooks/useCredentialGrants.ts': CREDENTIAL_UNIT,
  'src/components/settings/view/tabs/agents-settings/governanceToneNeutrality.test.tsx': AGY_GOVERNANCE,
  'src/components/settings/view/tabs/agents-settings/instructionSources.test.tsx': AGY_GOVERNANCE,
  'src/components/settings/view/tabs/ThemePresetPicker.tsx': THEME,
  'src/constants/providerModelFallbacks.ts': 'cursor/agy/opencode catalogs list Google gemini-* models',
  'src/i18n/locales/ar/settings.json': 'agy GEMINI.md governance channel text',
  'src/i18n/locales/de/settings.json': THEME,
  'src/i18n/locales/en/settings.json': 'agy GEMINI.md governance channel text',
  'src/i18n/locales/it/settings.json': THEME,
  'src/i18n/locales/ja/settings.json': THEME,
  'src/i18n/locales/ko/settings.json': THEME,
  'src/i18n/locales/ru/settings.json': THEME,
  'src/i18n/locales/tr/settings.json': THEME,
  'src/i18n/locales/zh-CN/settings.json': THEME,
  'src/lib/theme-presets.ts': THEME,
  'scripts/export-public.sh': 'publishes the neutral GEMINI.md that agy reads',
  'scripts/link-content.sh': 'materializes the GEMINI.md agy reads',
  'scripts/link-content.test.mjs': 'asserts GEMINI.md materialization for agy',
  'scripts/governance-write-guard.test.mjs': 'asserts the GEMINI.md governance entrypoint agy reads',
  'docs/team-wiki/00-updates.md': 'historical release note (history stays untouched)',
  '.env.example': 'GEMINI_API_KEY for OpenCode Google models and the GEMINI_* strip namespace',
  'src/lib/themeBoot.test.ts': THEME,
  'src/lib/themePrimaryContrast.test.ts': THEME,
  'src/lib/themeRingContrast.test.ts': THEME,
  'src/lib/themeStatusContrast.test.ts': THEME,
});

function collectMatchingFiles(): string[] {
  const matches: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
      const relative = path.posix.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(relative);
      } else if (entry.isFile() && PATTERN.test(fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8'))) {
        matches.push(relative);
      }
    }
  };
  for (const root of SCANNED_ROOTS) walk(root);
  for (const file of SCANNED_FILES) {
    if (PATTERN.test(fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'))) matches.push(file);
  }
  return matches.sort();
}

test('every gemini mention in the scanned roots is allowlisted with a reason', () => {
  const unlisted = collectMatchingFiles().filter((file) => !Object.hasOwn(ALLOWLIST, file));
  assert.deepEqual(unlisted, [], 'remove the leftover, or allowlist it with a one-line reason');
});

test('no allowlist entry is stale (a missing mention may be a wrong agy deletion)', () => {
  const matching = new Set(collectMatchingFiles());
  const stale = Object.keys(ALLOWLIST).filter((file) => !matching.has(file));
  assert.deepEqual(stale, [], 'check the agy dependency was not deleted, then drop the entry');
});

test('every allowlist entry carries a non-empty reason', () => {
  for (const [file, reason] of Object.entries(ALLOWLIST)) {
    assert.ok(reason.trim().length > 0, `${file} needs a reason`);
  }
});
