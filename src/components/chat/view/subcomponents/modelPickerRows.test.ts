/**
 * modelPickerRows.test.ts — B-245: one row per runnable combination, each naming
 * its engine.
 *
 * The rules pinned here are the ones the old picker broke:
 *   - the Claude body's engine rows are IN its group, not appended after every
 *     other body (that is what put "Claude engine on GLM" ninth of nine);
 *   - an engine with no stored key still appears, as a locked row, so an unkeyed
 *     engine is visibly available rather than silently absent;
 *   - our z.ai carrier and opencode's paid Zen route are told apart by their
 *     engine sentence, not by a parenthesis in the label;
 *   - no other body gets an engineProvider — ADR-073 §4 forbids launching a
 *     non-Claude body on a custom engine before that body's config guard exists,
 *     and this picker must not be the thing that quietly grants it.
 */
import { describe, expect, it } from 'vitest';

import type { LLMProvider, ProviderModelsDefinition } from '../../../../types/app';

import { rowsForBody } from './modelPickerRows';

const def = (...values: string[]): ProviderModelsDefinition => ({
  OPTIONS: values.map((value) => ({ value, label: value })),
  DEFAULT: values[0],
});

const CATALOG: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
  claude: def('default', 'sonnet'),
  glm: def('glm-5.2'),
  kimi: def('kimi-k2.6'),
  // The real opencode listing: our carrier and Zen's paid route side by side.
  opencode: def('opencode/big-pickle', 'opencode/glm-5.2', 'glm/glm-5.2'),
  codex: def('gpt-5.6-sol'),
};

const KEYED = { glm: true, kimi: true };

describe('the Claude body carries its own engine rows', () => {
  const rows = rowsForBody('claude', CATALOG, KEYED);

  it('lists its native models first, on its own engine', () => {
    expect(rows.slice(0, 2).map((r) => r.model)).toEqual(['default', 'sonnet']);
    expect(rows[0].engineProvider).toBeNull();
    expect(rows[0].engine).toEqual({ key: 'subscription', vars: { engine: 'Anthropic' } });
  });

  it('includes the GLM engine row that used to sit below the fold', () => {
    const glm = rows.find((r) => r.engineProvider === 'glm');
    expect(glm).toBeDefined();
    expect(glm!.model).toBe('glm-5.2');
    expect(glm!.engine).toEqual({ key: 'yourKey', vars: { host: 'api.z.ai' } });
    expect(glm!.locked).toBe(false);
  });

  it('shows an unkeyed engine as a locked row instead of hiding it', () => {
    const unkeyed = rowsForBody('claude', CATALOG, { glm: true });
    const kimi = unkeyed.find((r) => r.engineProvider === 'kimi');
    expect(kimi?.locked).toBe(true);
    expect(kimi?.engine.key).toBe('needsKey');
    // A locked row names no model — selecting it opens settings.
    expect(kimi?.model).toBe('');
  });

  it('gives every row a unique key', () => {
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('the OpenCode body tells its upstreams apart by engine, not by label', () => {
  const rows = rowsForBody('opencode', CATALOG, KEYED);
  const byModel = (model: string) => rows.find((r) => r.model === model)!;

  it('names our carrier as the operator key on z.ai', () => {
    expect(byModel('glm/glm-5.2').engine).toEqual({ key: 'yourKey', vars: { host: 'api.z.ai' } });
  });

  it("names opencode's own route as Zen, which bills against a balance", () => {
    expect(byModel('opencode/glm-5.2').engine).toEqual({ key: 'zen', vars: {} });
  });

  it('separates the two same-slug rows that a label alone could not', () => {
    expect(byModel('glm/glm-5.2').engine).not.toEqual(byModel('opencode/glm-5.2').engine);
  });
});

describe('no body other than Claude is handed an engine', () => {
  it.each<LLMProvider>(['opencode', 'codex', 'kimi'])('%s rows pin no engineProvider', (body) => {
    for (const row of rowsForBody(body, CATALOG, KEYED)) {
      expect(row.engineProvider).toBeNull();
    }
  });

  it('returns nothing for a body with no catalog entry', () => {
    expect(rowsForBody('cursor', CATALOG, KEYED)).toEqual([]);
  });
});
