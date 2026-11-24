/** T-2094: project-member removal kills the member's pooled agy processes at once. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { agyAcpPool } from '../agy-acp-runner.js';
import { wireAgyAcpLifecycle } from '../agy-acp-lifecycle.js';

function pooled(key: string, userId: number, cwd: string) {
  const h = { pid: 1, killed: 0, kill() { h.killed += 1; }, onExit() {} };
  const got = agyAcpPool.acquire({ key, userId, fingerprint: 'f', cwd, spawn: () => h });
  agyAcpPool.release((got as any).entry);
  return h;
}

test('member removal kills that member\'s processes in the project only, unless access remains', () => {
  let listener: (e: any) => void = () => {};
  const unwire = wireAgyAcpLifecycle({ onMemberRemoved: (l: any) => { listener = l; return () => {}; } });
  const inProject = pooled('5:A', 5, '/proj/x');
  const elsewhere = pooled('5:B', 5, '/proj/y');
  listener({ projectId: 'p', projectPath: '/proj/x', userId: 5, removedBy: 1, stillHasAccess: true });
  assert.equal(inProject.killed, 0, 'an admin who keeps access keeps the process');
  listener({ projectId: 'p', projectPath: '/proj/x', userId: 5, removedBy: 1, stillHasAccess: false });
  assert.equal(inProject.killed, 1);
  assert.equal(elsewhere.killed, 0);
  unwire();
  agyAcpPool.shutdown();
});

test('grant changes reach pooled processes through warm-credential-processes, not a second event bus', () => {
  const src = fs.readFileSync(new URL('../agy-acp-lifecycle.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /credential-grant-events|onCredentialGrantChanged/);
  const gone = new URL('../../../../../services/isolation/credential-grant-events.js', import.meta.url);
  assert.equal(fs.existsSync(gone), false);
});
