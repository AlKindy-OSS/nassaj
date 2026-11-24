/**
 * T-2095 acceptance (A1–A4), in the owner's terms: "after an agent turn I can
 * see exactly what that turn changed, secrets never land in the checkpoint
 * store, another member cannot see my checkpoints, and a shared live root is
 * never checkpointed". Drives the real capture wrapper and the real /api/git
 * routes over a real repository under /var/tmp; only the database edge is mocked.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import test, { after, mock } from 'node:test';

import express from 'express';

import {
  bindSessionWorkspace,
  createSessionWorkspace,
} from '@/modules/session-workspaces/index.js';

const OWNER = 41;
const MEMBER_B = 77;
const repository = fs.mkdtempSync('/var/tmp/nassaj-turn-checkpoints-acceptance-');
const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim();

git('init', '-q', '-b', 'main');
git('config', 'user.name', 'Checkpoint Fixture');
git('config', 'user.email', 'checkpoint@example.test');
fs.writeFileSync(path.join(repository, 'a.ts'), 'export const a = 1;\n');
fs.writeFileSync(path.join(repository, 'c.ts'), 'export const c = 3;\n');
fs.writeFileSync(path.join(repository, '.gitignore'), '.env\n');
git('add', 'a.ts', 'c.ts', '.gitignore');
git('commit', '-q', '-m', 'chore: checkpoint baseline');
const commonGitDir = fs.realpathSync(path.join(repository, '.git'));

createSessionWorkspace({ projectPath: repository, launchKey: 'acceptance-launch', principalId: OWNER });
const binding = bindSessionWorkspace({
  projectPath: repository, launchKey: 'acceptance-launch', sessionId: 'acceptance-session', principalId: OWNER,
});

mock.module('@/modules/database/index.js', {
  namedExports: {
    projectsDb: {
      isProjectVisibleToUser: () => true,
      isProjectWritableByUser: () => true,
      getProjectPathById: () => repository,
    },
    userDb: { getGitConfig: () => ({ git_name: 'Reader', git_email: 'reader@example.test' }) },
    githubTokensDb: { getActiveGithubToken: () => null },
  },
});
mock.module('@/claude-sdk.js', { namedExports: { queryClaudeSDK: async () => undefined } });
mock.module('@/cursor-cli.js', { namedExports: { spawnCursor: async () => undefined } });

const { withTurnCheckpoint, checkpointStorePath } = await import('./index.js');
// eslint-disable-next-line boundaries/no-unknown -- the acceptance test drives the real /api/git router.
const gitRouter = (await import('../../routes/git.js')).default;
const app = express();
app.use((req, _res, next) => {
  const asUser = Number(req.headers['x-test-user'] ?? OWNER);
  (req as express.Request & { user: unknown }).user = { id: asUser, role: 'user' };
  next();
});
app.use('/api/git', gitRouter);
const server = app.listen(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const { port } = server.address() as AddressInfo;

async function get(route: string, user = OWNER) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { headers: { 'x-test-user': String(user) } });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const coordinates = () => `project=p1&sessionId=acceptance-session&generation=${encodeURIComponent(binding.generation)}`;

type Frame = { kind: string; turnSeq?: number; status?: string; reason?: string; withheldCount?: number };
function recordingWriter() {
  const frames: Frame[] = [];
  return { frames, send: (frame: Frame) => { frames.push(frame); } };
}

function turnContext(writer: ReturnType<typeof recordingWriter>, workspace: unknown = binding, principalId: number | null = OWNER) {
  return { sessionWorkspace: workspace, principalId, provider: 'claude', clientMsgId: 'client-msg-1', writer };
}

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { git('worktree', 'prune'); } finally { fs.rmSync(repository, { recursive: true, force: true }); }
});

test('A1: the turn view lists exactly the edited, added and deleted files with matching diff text', async () => {
  const writer = recordingWriter();
  await withTurnCheckpoint(turnContext(writer), async () => {
    fs.writeFileSync(path.join(binding.cwd, 'a.ts'), 'export const a = 2;\n');
    fs.writeFileSync(path.join(binding.cwd, 'b.ts'), 'export const b = 2;\n');
    fs.rmSync(path.join(binding.cwd, 'c.ts'));
  });
  await new Promise((resolve) => setImmediate(resolve));
  const event = writer.frames.find((frame) => frame.kind === 'turn_checkpoint');
  assert.equal(event?.status, 'captured');
  const turnSeq = event!.turnSeq!;

  const list = await get(`/api/git/turn-checkpoints?${coordinates()}`);
  assert.equal(list.status, 200);
  const turns = list.body.turns as Array<{ turnSeq: number; files: Array<{ path: string; status: string }> }>;
  const turn = turns.find((entry) => entry.turnSeq === turnSeq)!;
  assert.deepEqual(
    turn.files.map((file) => `${file.status} ${file.path}`).sort(),
    ['A b.ts', 'D c.ts', 'M a.ts'],
  );

  const diff = await get(`/api/git/turn-checkpoints/diff?${coordinates()}&turnSeq=${turnSeq}&path=a.ts`);
  assert.equal(diff.status, 200);
  assert.match(String(diff.body.diff), /-export const a = 1;\n\+export const a = 2;/);
});

test('A2: secrets written by the agent never enter the store and are listed as withheld', async () => {
  const secrets = {
    env: 'API_TOKEN=plain-env-secret-value-0001\n',
    idRsa: ['-----BEGIN OPENSSH ', 'PRIVATE KEY-----\nb3BlbnNzaC1rZXkt' + 'djEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH ', 'PRIVATE KEY-----\n'].join(''),
    config: `{"apiKey": "${['sk', 'ant', 'api03', 'Zq9XwPr7Lm2N' + 'b5Vc8Kd3Ht6Fg1Js4Ay0'].join('-')}"}\n`,
    sqlite: Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.from('sqlite-row-secret-0002')]),
  };
  const writer = recordingWriter();
  await withTurnCheckpoint(turnContext(writer), async () => {
    fs.writeFileSync(path.join(binding.cwd, '.gitignore'), '!.env\n');
    fs.writeFileSync(path.join(binding.cwd, '.env'), secrets.env);
    fs.writeFileSync(path.join(binding.cwd, 'id_rsa'), secrets.idRsa);
    fs.writeFileSync(path.join(binding.cwd, 'config.json'), secrets.config);
    fs.writeFileSync(path.join(binding.cwd, 'data.bin'), secrets.sqlite);
  });
  await new Promise((resolve) => setImmediate(resolve));
  const event = writer.frames.find((frame) => frame.kind === 'turn_checkpoint')!;
  assert.equal(event.status, 'captured');
  assert.ok((event.withheldCount ?? 0) >= 4);

  const store = checkpointStorePath({ commonGitDir, principalId: String(OWNER), overlayId: binding.overlayId });
  const objects = execFileSync('git', ['--git-dir', store, 'cat-file', '--batch-all-objects', '--batch'], {
    maxBuffer: 256 * 1024 * 1024,
  });
  for (const needle of ['plain-env-secret-value-0001', 'b3BlbnNzaC1rZXkt' + 'djEAAAAABG5vbmUAAAAEbm9uZQ',
    'Zq9XwPr7Lm2N' + 'b5Vc8Kd3Ht6Fg1Js4Ay0', 'sqlite-row-secret-0002']) {
    assert.equal(objects.includes(Buffer.from(needle)), false, `store leaked ${needle}`);
  }

  const list = await get(`/api/git/turn-checkpoints?${coordinates()}`);
  const turn = (list.body.turns as Array<{ turnSeq: number; files: Array<{ path: string; status: string }> }>)
    .find((entry) => entry.turnSeq === event.turnSeq)!;
  const withheld = turn.files.filter((file) => file.status === 'withheld').map((file) => file.path).sort();
  assert.deepEqual(withheld, ['.env', 'config.json', 'data.bin', 'id_rsa']);
  assert.ok(turn.files.some((file) => file.path === '.gitignore' && file.status === 'M'));
});

test('A3: member B gets the same 404 for list and diff, and has no store', async () => {
  const list = await get(`/api/git/turn-checkpoints?${coordinates()}`, MEMBER_B);
  const diff = await get(`/api/git/turn-checkpoints/diff?${coordinates()}&turnSeq=1`, MEMBER_B);
  const missing = await get('/api/git/turn-checkpoints?project=p1&sessionId=nope&generation=nope', OWNER);
  assert.equal(list.status, 404);
  assert.equal(diff.status, 404);
  assert.deepEqual(list.body, missing.body);
  assert.deepEqual(diff.body, missing.body);
  const storeB = checkpointStorePath({ commonGitDir, principalId: String(MEMBER_B), overlayId: binding.overlayId });
  assert.equal(fs.existsSync(storeB), false);
});

test('A4: a shared live root is skipped as not_overlay and creates no store', async () => {
  const shared = Object.freeze({
    isolation: 'legacy_shared', logicalProjectPath: repository, cwd: repository,
    baseOid: null, overlayId: null, sessionId: 'shared-session', generation: null,
  });
  const before = fs.readdirSync(path.join(commonGitDir, 'nassaj-checkpoints', 'v1'));
  const writer = recordingWriter();
  let ran = false;
  await withTurnCheckpoint(turnContext(writer, shared), async () => { ran = true; });
  assert.equal(ran, true);
  await new Promise((resolve) => setImmediate(resolve));
  const event = writer.frames.find((frame) => frame.kind === 'turn_checkpoint')!;
  assert.equal(event.status, 'skipped');
  assert.equal(event.reason, 'not_overlay');
  assert.deepEqual(fs.readdirSync(path.join(commonGitDir, 'nassaj-checkpoints', 'v1')), before);
});

test('QA condition 6: every miss is the same 404, never the shared root; inputs are validated', async () => {
  const missing = await get('/api/git/turn-checkpoints?project=p1&sessionId=nope&generation=nope');
  const stale = await get('/api/git/turn-checkpoints?project=p1&sessionId=acceptance-session&generation=stale');
  const uncoordinated = await get('/api/git/turn-checkpoints?project=p1');
  const halfCoordinated = await get('/api/git/turn-checkpoints?project=p1&sessionId=acceptance-session');
  const unknownTurn = await get(`/api/git/turn-checkpoints/diff?${coordinates()}&turnSeq=9999`);
  for (const response of [stale, uncoordinated, halfCoordinated, unknownTurn]) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, missing.body);
  }
  for (const turnSeq of ['abc', '0', '1e3', '-1', '../1', '123456789']) {
    const response = await get(`/api/git/turn-checkpoints/diff?${coordinates()}&turnSeq=${encodeURIComponent(turnSeq)}`);
    assert.equal(response.status, 400, turnSeq);
  }
  for (const file of ['../a.ts', '/etc/passwd', 'a/../../b', './']) {
    const response = await get(`/api/git/turn-checkpoints/diff?${coordinates()}&turnSeq=1&path=${encodeURIComponent(file)}`);
    assert.equal(response.status, 400, file);
  }
});

test('the turn list is paginated newest first', async () => {
  const first = await get(`/api/git/turn-checkpoints?${coordinates()}&limit=1`);
  const turns = first.body.turns as Array<{ turnSeq: number }>;
  assert.equal(turns.length, 1);
  assert.equal(typeof first.body.nextBefore, 'number');
  const next = await get(`/api/git/turn-checkpoints?${coordinates()}&limit=1&before=${first.body.nextBefore}`);
  assert.ok((next.body.turns as Array<{ turnSeq: number }>)[0].turnSeq < turns[0].turnSeq);
  const bad = await get(`/api/git/turn-checkpoints?${coordinates()}&before=x`);
  assert.equal(bad.status, 400);
});
