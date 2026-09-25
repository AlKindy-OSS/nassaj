/**
 * ADR-172 qa ن1 — cost of owning-project resolution at activation scale:
 * ~170 registered projects (real directories, some symlinked, some missing),
 * filtering 50 session paths as the WS id-list filter does. Prints BENCH lines
 * and bounds the per-check cost so a regression to a per-call full scan fails.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test, { after, before } from 'node:test';

import { closeConnection, getConnection, initializeDatabase, projectsDb, userDb } from '@/modules/database/index.js';
import { canAccessProjectPath, findOwningProject } from '@/modules/database/repositories/project-access.js';

const PROJECTS = 170;
const CHECKS = 50;
const paths: string[] = [];
let userId = 0;

before(async () => {
  closeConnection();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adr172-bench-'));
  process.env.WORKSPACES_ROOT = root;
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await initializeDatabase();
  userId = (userDb.createUser('bench_user', 'hash', 'user') as { id: number }).id;
  for (let i = 0; i < PROJECTS; i += 1) {
    const dir = path.join(root, 'projects', `p${String(i).padStart(3, '0')}`);
    if (i % 10 !== 9) fs.mkdirSync(dir, { recursive: true }); // every 10th is missing on disk
    let registered = dir;
    if (i % 17 === 0) {
      registered = path.join(root, `link-${i}`);
      fs.symlinkSync(path.join(root, 'projects'), registered === dir ? `${dir}-l` : registered);
      registered = path.join(registered, `p${String(i).padStart(3, '0')}`);
    }
    projectsDb.createProjectPath(registered, `P${i}`, i % 2 === 0 ? userId : null);
    paths.push(dir);
  }
});

after(() => {
  closeConnection();
  delete process.env.WORKSPACES_ROOT;
});

test('50 owning-project checks over ~170 projects stay cheap', () => {
  process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
  try {
    const sample = Array.from({ length: CHECKS }, (_, i) => paths[(i * 7) % PROJECTS]);
    canAccessProjectPath(sample[0], userId); // warm-up (first cache fill)
    const t0 = performance.now();
    let allowed = 0;
    for (const p of sample) if (canAccessProjectPath(p, userId)) allowed += 1;
    const exactMs = performance.now() - t0;
    const nested = sample.map((p) => path.join(p, 'src', 'deep'));
    const t1 = performance.now();
    for (const p of nested) findOwningProject(p);
    const nestedMs = performance.now() - t1;
    console.log(`BENCH projects=${PROJECTS} checks=${CHECKS} exact=${exactMs.toFixed(1)}ms nested=${nestedMs.toFixed(1)}ms allowed=${allowed}`);
    assert.ok(allowed > 0);
    assert.ok(exactMs < Number(process.env.ADR172_BENCH_LIMIT_MS ?? 40), `exact checks took ${exactMs}ms`);
    assert.ok(nestedMs < Number(process.env.ADR172_BENCH_LIMIT_MS ?? 40), `nested checks took ${nestedMs}ms`);
  } finally {
    delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  }
});

test('cache sees writes made outside projects.db (signature) and through it (invalidation)', () => {
  const base = path.dirname(paths[0]);
  const raw = path.join(base, 'raw-insert');
  fs.mkdirSync(raw, { recursive: true });
  assert.equal(findOwningProject(path.join(raw, 'x')), null, 'not yet registered');
  getConnection().prepare("INSERT INTO projects (project_id, project_path) VALUES ('raw-1', ?)").run(raw);
  assert.equal(findOwningProject(path.join(raw, 'x'))?.project_id, 'raw-1', 'raw SQL insert detected');

  const viaRepo = path.join(base, 'repo-insert');
  fs.mkdirSync(viaRepo, { recursive: true });
  const id = projectsDb.createProjectPath(viaRepo, 'R', userId).project!.project_id;
  assert.equal(findOwningProject(path.join(viaRepo, 'y'))?.project_id, id);
  projectsDb.deleteProjectById(id);
  assert.equal(findOwningProject(path.join(viaRepo, 'y')), null, 'delete invalidates');
});
