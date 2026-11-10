/**
 * B-1739: a Claude session moved to another project directory (file linked into
 * the new slug, old path unlinked, the Nassaj `sessions` row repointed) must be
 * counted ONCE and attributed to the project the `sessions` row names, not to
 * the stale `cwd` inside the transcript. Installs already double-counted by the
 * old code heal on the next ordinary (non-forced) scan.
 */
import assert from 'node:assert/strict';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  closeConnection, getConnection, initializeDatabase, projectCostLedgerDb, projectsDb, sessionsDb,
} from '@/modules/database/index.js';

import { costLedgerService, PATH_PROJECT_ID_PREFIX } from './cost-ledger.service.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');
const DAY = new Date(2026, 2, 10, 12);
const SID = 'sess-moved-1';
const OLD_SLUG = '-ws-General';
const NEW_SLUG = '-ws-Tech';

type Layout = { root: string; general: string; tech: string; oldFile: string; newFile: string };

async function withLayout(run: (layout: Layout) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'ledger-move-')));
  closeConnection();
  process.env.DATABASE_PATH = path.join(temp, 'auth.db');
  await initializeDatabase();
  costLedgerService._resetCaches();
  const root = path.join(temp, 'claude', 'projects');
  const general = path.join(temp, 'ws', 'General');
  const tech = path.join(temp, 'ws', 'Tech');
  await mkdir(path.join(root, OLD_SLUG), { recursive: true });
  await mkdir(path.join(root, NEW_SLUG), { recursive: true });
  await mkdir(general, { recursive: true });
  await mkdir(tech, { recursive: true });
  const lines = (await readFile(path.join(FIXTURES, 'claude-parent.jsonl'), 'utf8'))
    .split('\n').filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.stringify({ ...JSON.parse(line), timestamp: DAY.toISOString(), cwd: general, sessionId: SID }));
  const oldFile = path.join(root, OLD_SLUG, `${SID}.jsonl`);
  await writeFile(oldFile, `${lines.join('\n')}\n`);
  try {
    await run({ root, general, tech, oldFile, newFile: path.join(root, NEW_SLUG, `${SID}.jsonl`) });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(temp, { recursive: true, force: true });
  }
}

const scan = (layout: Layout, force = false) =>
  costLedgerService.scan({ claudeRoots: [layout.root], harnesses: ['claude'], force });

const oldKey = `claude-rel:0/${OLD_SLUG}/${SID}.jsonl`;
const newKey = `claude-rel:0/${NEW_SLUG}/${SID}.jsonl`;

const sourceKeys = (): string[] => (getConnection()
  .prepare('SELECT source_key FROM project_cost_sources ORDER BY source_key').all() as { source_key: string }[])
  .map((row) => row.source_key);

const dailyKeys = (): string[] => (getConnection()
  .prepare('SELECT DISTINCT source_key FROM project_cost_daily ORDER BY source_key').all() as { source_key: string }[])
  .map((row) => row.source_key);

const projectTotal = (projectPath: string): number => costLedgerService
  .getProjectDaily(`${PATH_PROJECT_ID_PREFIX}${projectPath}`)
  .reduce((sum, row) => sum + row.totalUsd, 0);

/** What the operator did on the fleet node: link into the new slug, unlink the old, repoint the row. */
async function moveSession(layout: Layout): Promise<void> {
  await link(layout.oldFile, layout.newFile);
  await unlink(layout.oldFile);
  projectsDb.ensureProjectPathForSession(layout.tech);
  getConnection().prepare('UPDATE sessions SET project_path = ?, jsonl_path = ? WHERE session_id = ?')
    .run(layout.tech, layout.newFile, SID);
}

test('moved session: one source, totals not doubled, attributed to the sessions row project', async () => {
  await withLayout(async (layout) => {
    sessionsDb.createSession(SID, 'claude', layout.general, undefined, undefined, undefined, layout.oldFile);
    await scan(layout);
    const expected = projectTotal(layout.general);
    assert.ok(expected > 0, 'fixture carries priced usage');
    assert.deepEqual(sourceKeys(), [oldKey]);

    await moveSession(layout);
    await scan(layout);

    assert.deepEqual(sourceKeys(), [newKey], 'exactly one source for the session');
    assert.deepEqual(dailyKeys(), [newKey]);
    assert.equal(projectTotal(layout.tech), expected, 'Tech carries the single transcript total');
    assert.equal(projectTotal(layout.general), 0, 'General no longer carries it');
  });
});

test('already double-counted install heals on the next non-forced scan', async () => {
  await withLayout(async (layout) => {
    sessionsDb.createSession(SID, 'claude', layout.general, undefined, undefined, undefined, layout.oldFile);
    await scan(layout);
    const expected = projectTotal(layout.general);
    await moveSession(layout);
    // The pre-fix code wrote the new key with the same General rows and a watermark matching the file.
    const db = getConnection();
    db.prepare(`INSERT INTO project_cost_daily (source_key, project_id, project_path, day, vendor, model, harness,
      cost_usd, priced, assumed, input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
      cache_read_tokens, requests, prices_as_of, updated_at) SELECT ?, project_id, project_path, day, vendor, model, harness,
      cost_usd, priced, assumed, input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens,
      cache_read_tokens, requests, prices_as_of, updated_at FROM project_cost_daily WHERE source_key = ?`)
      .run(newKey, oldKey);
    const signature = await stat(layout.newFile);
    projectCostLedgerDb.replaceSource(
      { sourceKey: newKey, provider: 'claude', mtimeMs: Math.round(signature.mtimeMs), sizeBytes: signature.size }, []);
    assert.equal(projectTotal(layout.general), expected * 2, 'reproduces the doubled state');

    await scan(layout);

    assert.deepEqual(sourceKeys(), [newKey]);
    assert.deepEqual(dailyKeys(), [newKey]);
    assert.equal(projectTotal(layout.tech), expected);
    assert.equal(projectTotal(layout.general), 0);

    const again = await scan(layout);
    assert.equal(again.scanned, 0, 'healed source is skipped afterwards (no perpetual rescan)');
  });
});

test('orphan-folder form of the old key is absorbed too when the folder is gone', async () => {
  await withLayout(async (layout) => {
    sessionsDb.createSession(SID, 'claude', layout.tech, undefined, undefined, undefined, layout.newFile);
    await link(layout.oldFile, layout.newFile);
    await unlink(layout.oldFile);
    const orphanKey = `claude-rel:0/${OLD_SLUG}/${SID}`;
    projectCostLedgerDb.replaceSource({ sourceKey: orphanKey, provider: 'claude', mtimeMs: 1, sizeBytes: 1 }, [{
      projectId: `${PATH_PROJECT_ID_PREFIX}${layout.general}`, projectPath: layout.general, day: '2026-03-10',
      vendor: 'anthropic', model: 'claude-x', harness: 'claude', costUsd: 9, priced: true, assumed: false,
      tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, requests: 1, pricesAsOf: '2026-01-01',
    }]);

    await scan(layout);

    assert.deepEqual(sourceKeys(), [newKey]);
    assert.deepEqual(dailyKeys(), [newKey]);
  });
});

test('old file still exists (a real copy): not absorbed', async () => {
  await withLayout(async (layout) => {
    await scan(layout);
    await copyFile(layout.oldFile, layout.newFile);
    await scan(layout);
    assert.deepEqual(sourceKeys(), [oldKey, newKey]);
  });
});

test('no sessions row: transcript cwd is used', async () => {
  await withLayout(async (layout) => {
    await scan(layout);
    assert.ok(projectTotal(layout.general) > 0);
    assert.equal(projectTotal(layout.tech), 0);
  });
});
