/**
 * T-1880 (M-B): Claude cost source keys are spelling-independent
 * (`claude-rel:<rootId>/<slug>/<rel>`), legacy absolute keys of the SAME file
 * are absorbed exactly once, and nothing outside the exact candidate set —
 * another provider, a LIKE-wildcard lookalike — is ever touched.
 *
 * Layout under test mirrors the separation: before, `~/.claude` is a symlink
 * to the governance checkout; after, `$CH/projects/<slug>` is real and the
 * checkout keeps a compat link. Rows use real fixture lines (restamped).
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectCostLedgerDb } from '@/modules/database/index.js';

import { costLedgerService, localDay, PATH_PROJECT_ID_PREFIX } from './cost-ledger.service.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const DAY = new Date(2026, 2, 10, 12);
const OLD_DAY = '2026-01-05';
const SLUG = '-ws_a%b';

type Layout = { core: string; ch: string; workspace: string; legacyFile: string; newFile: string };

async function withLayout(run: (layout: Layout) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'ledger-keys-')));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temp, 'auth.db');
  await initializeDatabase();
  costLedgerService._resetCaches();
  const core = path.join(temp, 'nassaj-core');
  const ch = path.join(temp, '.claude');
  const workspace = path.join(temp, 'workspace');
  await mkdir(path.join(core, 'projects', SLUG), { recursive: true });
  await symlink(core, ch); // legacy layout: ~/.claude -> checkout
  const lines = (await readFile(path.join(FIXTURES, 'claude-parent.jsonl'), 'utf8'))
    .split('\n').filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.stringify({ ...JSON.parse(line), timestamp: DAY.toISOString(), cwd: workspace }));
  await writeFile(path.join(core, 'projects', SLUG, 's.jsonl'), `${lines.join('\n')}\n`);
  try {
    await run({
      core, ch, workspace,
      legacyFile: path.join(core, 'projects', SLUG, 's.jsonl'),
      newFile: path.join(ch, 'projects', SLUG, 's.jsonl'),
    });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(temp, { recursive: true, force: true });
  }
}

/** Separation of one slug: real `$CH/projects`, slug moved there, compat link left behind. */
async function separate({ core, ch }: Layout): Promise<void> {
  await rm(ch);
  await mkdir(path.join(ch, 'projects'), { recursive: true });
  await rename(path.join(core, 'projects', SLUG), path.join(ch, 'projects', SLUG));
  await symlink(path.join(ch, 'projects', SLUG), path.join(core, 'projects', SLUG));
}

const scan = (layout: Layout, force = false) => costLedgerService.scan({
  claudeRoots: [path.join(layout.ch, 'projects')],
  claudeLegacyRoots: [path.join(layout.core, 'projects')],
  harnesses: ['claude'],
  force,
});

const keys = (): string[] => (getConnection()
  .prepare('SELECT source_key FROM project_cost_sources ORDER BY source_key').all() as { source_key: string }[])
  .map((row) => row.source_key);

const dailyKeys = (): string[] => (getConnection()
  .prepare('SELECT DISTINCT source_key FROM project_cost_daily ORDER BY source_key').all() as { source_key: string }[])
  .map((row) => row.source_key);

const totals = (workspace: string) => costLedgerService.getProjectDaily(`${PATH_PROJECT_ID_PREFIX}${workspace}`)
  .map((row) => [row.day, row.totalUsd]);

/** Re-keys what the new code wrote to what the pre-T-1880 code wrote: the file's absolute realpath. */
function simulateLegacyKeys(legacyFile: string): void {
  const db = getConnection();
  db.prepare("UPDATE project_cost_daily SET source_key = ? WHERE source_key LIKE 'claude-rel:%'").run(legacyFile);
  db.prepare("UPDATE project_cost_sources SET source_key = ? WHERE source_key LIKE 'claude-rel:%'").run(legacyFile);
}

test('new key is spelling-independent: same key before and after separation', async () => {
  await withLayout(async (layout) => {
    await scan(layout);
    const before = keys();
    assert.deepEqual(before, [`claude-rel:0/${SLUG}/s.jsonl`]);
    await separate(layout);
    await scan(layout, true);
    assert.deepEqual(keys(), before);
  });
});

test('legacy rows: non-forced rescan skips via candidate watermark; forced rescan absorbs, totals equal', async () => {
  await withLayout(async (layout) => {
    await scan(layout);
    const expected = totals(layout.workspace);
    assert.ok((expected[0]?.[1] as number) > 0);
    simulateLegacyKeys(layout.legacyFile);
    await separate(layout);

    const lazy = await scan(layout);
    assert.equal(lazy.scanned, 0, 'legacy watermark found through the exact candidate set');
    assert.deepEqual(totals(layout.workspace), expected);
    assert.deepEqual(keys(), [layout.legacyFile]);

    const forced = await scan(layout, true);
    assert.equal(forced.scanned, 1);
    assert.deepEqual(totals(layout.workspace), expected, 'no double count');
    assert.deepEqual(keys(), [`claude-rel:0/${SLUG}/s.jsonl`], 'no old-spelling source remains');
    assert.deepEqual(dailyKeys(), [`claude-rel:0/${SLUG}/s.jsonl`]);
  });
});

test('a legacy day the new reading no longer covers is re-keyed, not deleted (ADR-078)', async () => {
  await withLayout(async (layout) => {
    await scan(layout);
    simulateLegacyKeys(layout.legacyFile);
    const [row] = costLedgerService.getProjectDaily(`${PATH_PROJECT_ID_PREFIX}${layout.workspace}`);
    getConnection().prepare(`INSERT INTO project_cost_daily (source_key, project_id, project_path, day, vendor, model,
      harness, cost_usd) VALUES (?, ?, ?, ?, 'anthropic', 'claude-old', 'claude', 1.25)`)
      .run(layout.legacyFile, `${PATH_PROJECT_ID_PREFIX}${layout.workspace}`, layout.workspace, OLD_DAY);
    await separate(layout);
    await scan(layout, true);
    const days = totals(layout.workspace);
    assert.deepEqual(days, [[OLD_DAY, 1.25], [localDay(DAY.getTime()), row.totalUsd]]);
    assert.deepEqual(dailyKeys(), [`claude-rel:0/${SLUG}/s.jsonl`]);
  });
});

test('only exact claude candidates are absorbed: other providers and wildcard lookalikes survive', async () => {
  await withLayout(async (layout) => {
    const lookalikes = [
      path.join(layout.core, 'projects', '-wsXaYb', 's.jsonl'), // `_`/`%` as LIKE wildcards would match
      path.join(layout.core, 'projects', `${SLUG}Z`, 's.jsonl'), // prefix/suffix lookalike
      `${layout.legacyFile}.bak`,
    ];
    const cursorKey = path.join(layout.core, '..', '.cursor', 'projects', SLUG, 's.jsonl');
    const newFileLegacy = path.join(layout.ch, 'projects', SLUG, 's.jsonl');
    const seed = (sourceKey: string, provider: string) => projectCostLedgerDb.replaceSource(
      { sourceKey, provider, mtimeMs: 1, sizeBytes: 1 },
      [{ projectId: 'p', projectPath: '/p', day: OLD_DAY, vendor: 'v', model: 'm', harness: provider,
        costUsd: 2, priced: true, assumed: false, requests: 1, pricesAsOf: 'x',
        tokens: { input: 1, output: 1, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }],
    );
    for (const key of lookalikes) seed(key, 'claude');
    seed(cursorKey, 'cursor');
    seed(newFileLegacy, 'cursor'); // exact candidate string, but another provider owns it
    await separate(layout);
    await scan(layout, true);

    const remaining = keys();
    for (const key of [...lookalikes, cursorKey, newFileLegacy]) assert.ok(remaining.includes(key), key);
    const other = getConnection().prepare("SELECT SUM(cost_usd) AS s FROM project_cost_daily WHERE project_id = 'p'")
      .get() as { s: number };
    assert.equal(other.s, 2 * (lookalikes.length + 2));
  });
});
