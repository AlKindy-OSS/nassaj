/**
 * ADR-219 P2 §8 (ش-4, qa م-2): the REAL server entry refuses to start with the
 * dispatcher test seam on an unfenced database, before ANY database is opened.
 * The guard is a side-effect import placed right after load-env in index.js; a
 * reordering of imports or a regression in the guard fails this test.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO = path.resolve(import.meta.dirname, '../../../..');

function boot(databasePath: string, extra: Record<string, string> = {}) {
  const scratch = fs.mkdtempSync('/var/tmp/p2fence-');
  try {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'server/index.js'], {
      cwd: REPO, encoding: 'utf8', timeout: 90_000,
      env: { PATH: process.env.PATH, HOME: scratch, TMPDIR: '/var/tmp', NODE_ENV: 'development', DATABASE_PATH: databasePath,
        SERVER_PORT: '39998', HOST: '127.0.0.1', JWT_SECRET: 'x'.repeat(64), NASSAJ_PEER_RELAY_TEST_SEAMS: '1',
        TSX_TSCONFIG_PATH: path.join(REPO, 'server/tsconfig.json'), ...extra },
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('the server refuses the seam on a database outside /var/tmp/peer-p2-* and never creates it', () => {
  const scratch = fs.mkdtempSync('/var/tmp/p2fence-db-');
  try {
    const db = path.join(scratch, 'outside.sqlite');
    const { status, output } = boot(db);
    assert.notEqual(status, 0);
    assert.match(output, /peer relay test seams refused: DATABASE_PATH is not inside/u);
    assert.equal(fs.existsSync(db), false, 'the refused database was never opened or created');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the server refuses the seam under NODE_ENV=production even on a run-dir database', () => {
  const run = fs.mkdtempSync('/var/tmp/peer-p2-');
  try {
    const db = path.join(run, 'db.sqlite');
    const { status, output } = boot(db, { NODE_ENV: 'production' });
    assert.notEqual(status, 0);
    assert.match(output, /peer relay test seams refused: NODE_ENV is production/u);
    assert.equal(fs.existsSync(db), false);
  } finally {
    fs.rmSync(run, { recursive: true, force: true });
  }
});

test('index.js imports the guard as a side effect, right after load-env', () => {
  const lines = fs.readFileSync(path.join(REPO, 'server/index.js'), 'utf8').split('\n').filter((l) => l.startsWith('import '));
  assert.equal(lines[0], "import './load-env.js';");
  assert.equal(lines[1], "import './modules/peer-relay/peer-relay.test-seams-guard.js';");
});
