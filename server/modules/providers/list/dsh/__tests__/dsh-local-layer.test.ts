/**
 * ADR-227 "DSH local corrector" / T-2108 qa conditions 1, 2, 5 — the per-turn
 * layer of a local DSH turn: generated from the verified shipped layer as an
 * object (valid YAML), equal to it except the intended diff, naming the policy
 * plugin by its absolute verified path, with the DeepSeek web rows off, written
 * once 0600 in a 0700 nassaj-owned directory outside the member tree, and removed
 * (or swept at boot) when its turn is over.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { parse } from 'yaml';

import { nassajDshLayerPath, nassajDshPolicyPluginPath, readVerifiedNassajDshLayer } from '../dsh-launch.js';
import {
  DSH_LOCAL_DISABLED_ROWS, DSH_LOCAL_LAYER_FILE, DSH_LOCAL_TOKEN_ENV, buildDshLocalLayer, dshLocalRunsRoot,
  removeDshLocalRun, sweepStaleDshLocalRuns, writeDshLocalLayer,
} from '../dsh-local-layer.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 't2108-layer-'));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const PLUGIN_ENTRY = path.join(nassajDshPolicyPluginPath(), 'index.mjs');
const INPUT = { baseURL: 'http://127.0.0.1:43123', model: 'qwen3:30b', contextWindow: 32768, maxTokens: 4096, pluginEntry: PLUGIN_ENTRY };
const shipped = () => readVerifiedNassajDshLayer().text;
type Row = Record<string, any>;
const byId = (rows: Row[]) => new Map(rows.filter((row) => row.id).map((row) => [row.id, row]));

describe('the generated local layer (T-2108)', () => {
  it('is valid YAML (JSON) and equals the shipped layer except the intended diff', () => {
    const rows = buildDshLocalLayer(shipped(), INPUT);
    const reparsed = parse(JSON.stringify(rows)) as Row[];
    assert.deepEqual(reparsed, rows);
    const before = byId(parse(shipped()));
    const changed = [...byId(rows)].filter(([id, row]) => JSON.stringify(before.get(id)) !== JSON.stringify(row)).map(([id]) => id);
    assert.deepEqual(changed.sort(), ['acp', 'agent-default-model', 'compaction-basic', 'llm-deepseek', ...DSH_LOCAL_DISABLED_ROWS].sort());
    for (const id of before.keys()) assert.ok(byId(rows).has(id), `shipped row ${id} kept`);
  });

  it('points llm-deepseek at the corrector with the token variable and the one local model (ids like qwen3:30b)', () => {
    const llm = byId(buildDshLocalLayer(shipped(), INPUT)).get('llm-deepseek');
    assert.deepEqual(llm?.config, {
      baseURL: INPUT.baseURL, apiKeyEnv: DSH_LOCAL_TOKEN_ENV, maxTokens: 4096, defaultContextWindow: 32768,
      models: [{ id: 'qwen3:30b', name: 'qwen3:30b', contextWindow: 32768, maxTokens: 4096 }],
    });
    const rows = byId(buildDshLocalLayer(shipped(), INPUT));
    for (const id of ['agent-default-model', 'acp']) assert.equal(rows.get(id)?.config.model, 'qwen3:30b');
    assert.equal(rows.get('compaction-basic')?.config.summarizationModel, 'qwen3:30b');
    assert.ok(!JSON.stringify(buildDshLocalLayer(shipped(), INPUT)).includes('DEEPSEEK_API_KEY'));
  });

  it('qa condition 1: the policy plugin is named by its absolute verified path, still last', () => {
    const rows = buildDshLocalLayer(shipped(), INPUT);
    const insert = rows.at(-1)?.insert;
    assert.equal(insert?.[0]?.id, 'nassaj-policy');
    assert.equal(insert?.[0]?.name, PLUGIN_ENTRY);
    assert.ok(path.isAbsolute(insert?.[0]?.name));
    assert.throws(() => buildDshLocalLayer(shipped(), { ...INPUT, pluginEntry: './dsh-policy-plugin/index.mjs' }),
      (error: Error & { code?: string }) => error.code === 'dsh_policy_plugin_untrusted');
  });

  it('qa condition 2: the DeepSeek web search rows are disabled', () => {
    const rows = byId(buildDshLocalLayer(shipped(), INPUT));
    for (const id of ['web-search-deepseek', 'web-deepseek-api']) assert.equal(rows.get(id)?.disabled, true);
  });

  it('a shipped layer in another shape is refused', () => {
    assert.throws(() => buildDshLocalLayer('- id: x\n', INPUT), (error: Error & { code?: string }) => error.code === 'dsh_layer_untrusted');
  });

  it('the shipped layer is verified in memory: the returned bytes are the pinned ones', () => {
    const verified = readVerifiedNassajDshLayer();
    assert.equal(verified.file, nassajDshLayerPath());
    assert.equal(verified.text, fs.readFileSync(nassajDshLayerPath(), 'utf8'));
    const tampered = path.join(sandbox, 'tampered.yml');
    fs.writeFileSync(tampered, `${verified.text}\n# edit\n`);
    assert.throws(() => readVerifiedNassajDshLayer(tampered), (error: Error & { code?: string }) => error.code === 'dsh_layer_untrusted');
  });
});

describe('writing and removing the layer (T-2108)', () => {
  const root = path.join(sandbox, 'runs');

  it('writes once, 0600 in a 0700 per-run directory; a second write of the same run fails', () => {
    const { dir, file } = writeDshLocalLayer([{ id: 'x' }], { root, runId: 'run-a' });
    assert.equal(path.basename(file), DSH_LOCAL_LAYER_FILE);
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), [{ id: 'x' }]);
    assert.throws(() => writeDshLocalLayer([{ id: 'y' }], { root, runId: 'run-a' }));
    removeDshLocalRun(dir);
    assert.equal(fs.existsSync(dir), false);
  });

  it('a symlinked root is refused, never followed', () => {
    const target = path.join(sandbox, 'elsewhere');
    fs.mkdirSync(target);
    const link = path.join(sandbox, 'link-root');
    fs.symlinkSync(target, link);
    assert.throws(() => writeDshLocalLayer([], { root: link, runId: 'run-b' }));
    assert.deepEqual(fs.readdirSync(target), []);
  });

  it('the root is outside the member trees (the nassaj home, not .nassaj-users)', () => {
    assert.equal(dshLocalRunsRoot('/home/op'), '/home/op/.nassaj-dsh-local-runs');
  });

  it('the boot sweep removes directories of dead servers and keeps live ones', () => {
    const sweepRoot = path.join(sandbox, 'sweep');
    fs.mkdirSync(sweepRoot, { mode: 0o700 });
    const dead = path.join(sweepRoot, '999999999-old');
    const mine = path.join(sweepRoot, `${process.pid}-live`);
    for (const dir of [dead, mine]) fs.mkdirSync(dir);
    assert.equal(sweepStaleDshLocalRuns(sweepRoot), 1);
    assert.equal(fs.existsSync(dead), false);
    assert.equal(fs.existsSync(mine), true);
  });

  it('qa HIGH 3: the sweep skips names that are not <pid>-<run> (no NaN pid is deleted)', () => {
    const sweepRoot = path.join(sandbox, 'sweep-names');
    fs.mkdirSync(sweepRoot, { mode: 0o700 });
    const foreign = ['notes', 'abc-1', '-1-x', '12'].map((name) => path.join(sweepRoot, name));
    for (const dir of foreign) fs.mkdirSync(dir);
    assert.equal(sweepStaleDshLocalRuns(sweepRoot), 0);
    for (const dir of foreign) assert.equal(fs.existsSync(dir), true, dir);
  });

  it('qa HIGH 3: a symlinked or non-directory root is refused, never followed', () => {
    const target = path.join(sandbox, 'sweep-target');
    fs.mkdirSync(target);
    fs.mkdirSync(path.join(target, '999999998-old'));
    const link = path.join(sandbox, 'sweep-link');
    fs.symlinkSync(target, link);
    assert.equal(sweepStaleDshLocalRuns(link), 0);
    assert.equal(fs.existsSync(path.join(target, '999999998-old')), true);
    const file = path.join(sandbox, 'sweep-file');
    fs.writeFileSync(file, 'x');
    assert.equal(sweepStaleDshLocalRuns(file), 0);
  });
});
