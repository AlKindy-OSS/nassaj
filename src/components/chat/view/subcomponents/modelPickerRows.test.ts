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

/**
 * T-1906 (owner decision 2026-09-28): the Alibaba Coding Plan key is now
 * consumed through OpenCode's own catalog as `qwen-plan/*`. The server is
 * expected to filter its own answer by key status too; this is the client-side
 * half of that defense in depth, the same shape as the Claude-body engine gate
 * above.
 */
describe('qwen-plan models under OpenCode are gated behind the Alibaba key (T-1906)', () => {
  const catalogWithQwenPlan: Partial<Record<LLMProvider, ProviderModelsDefinition>> = {
    ...CATALOG,
    opencode: def('opencode/big-pickle', 'glm/glm-5.2', 'qwen-plan/qwen3-coder-plus'),
  };

  it('hides qwen-plan rows when no Alibaba key is stored', () => {
    const rows = rowsForBody('opencode', catalogWithQwenPlan, { glm: true, qwen: false });
    expect(rows.some((r) => r.model.startsWith('qwen-plan/'))).toBe(false);
    // Its siblings are untouched by the gate.
    expect(rows.some((r) => r.model === 'opencode/big-pickle')).toBe(true);
    expect(rows.some((r) => r.model === 'glm/glm-5.2')).toBe(true);
  });

  it('shows qwen-plan rows, named by host, once a key is stored', () => {
    const rows = rowsForBody('opencode', catalogWithQwenPlan, { glm: true, qwen: true });
    const qwenPlan = rows.find((r) => r.model === 'qwen-plan/qwen3-coder-plus');
    expect(qwenPlan).toBeDefined();
    expect(qwenPlan!.engine).toEqual({ key: 'yourKey', vars: { host: 'Alibaba Cloud' } });
    expect(qwenPlan!.engineProvider).toBeNull();
  });

  it('treats a missing qwen status the same as an explicit false (locked out by default)', () => {
    const rows = rowsForBody('opencode', catalogWithQwenPlan, { glm: true });
    expect(rows.some((r) => r.model.startsWith('qwen-plan/'))).toBe(false);
  });
});

describe('unified key mode lists only supported, linked cells (ADR-200 S9)', () => {
  const OPENCODE = def(
    'opencode/big-pickle',
    'moonshot/kimi-k2.6',
    'moonshotai/kimi-k2.6',
    'moonshotai-cn/kimi-k2.6',
    'Moonshot/kimi-k2.6',
    'deepseek/deepseek-chat',
    'glm/glm-5.2',
  );
  const catalog = { ...CATALOG, opencode: OPENCODE };
  const ids = (rows: ReturnType<typeof rowsForBody>) => rows.map((row) => row.model);

  it('hides a locked engine row instead of showing it greyed', () => {
    const rows = rowsForBody('claude', CATALOG, { glm: true }, undefined, { hideUnlinked: true });
    expect(rows.some((row) => row.locked)).toBe(false);
    expect(rows.some((row) => row.engineProvider === 'kimi')).toBe(false);
    expect(rows.some((row) => row.engineProvider === 'glm')).toBe(true);
  });

  it('keeps the locked CTA row when the mode is off (default)', () => {
    expect(rowsForBody('claude', CATALOG, { glm: true }).some((row) => row.locked)).toBe(true);
  });

  it('drops OpenCode cells whose vendor has no key, and only those', () => {
    const rows = rowsForBody('opencode', catalog, { kimi: true, glm: false, deepseek: false }, undefined, { hideUnlinked: true });
    expect(ids(rows)).toEqual(['opencode/big-pickle', 'moonshot/kimi-k2.6']);
  });

  it('lists the canonical vendor id only: no moonshotai, moonshot-cn or case variants', () => {
    const rows = rowsForBody('opencode', catalog, { kimi: true, glm: true, deepseek: true }, undefined, { hideUnlinked: true });
    expect(ids(rows)).toEqual(['opencode/big-pickle', 'moonshot/kimi-k2.6', 'deepseek/deepseek-chat', 'glm/glm-5.2']);
    // Aliases are spellings of one vendor and never rows, with the mode on or off.
    expect(ids(rowsForBody('opencode', catalog, { kimi: true })).some((id) => /^moonshotai|^Moonshot/.test(id))).toBe(false);
  });
});
