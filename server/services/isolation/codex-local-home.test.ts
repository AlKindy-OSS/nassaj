/**
 * T-2107: the credential-free CODEX_HOME of a local Codex run — no auth.json or
 * config.toml ever, sessions/ and governance linked to the member home, and a
 * refusal (never the member home) when continuity cannot be proven.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';

import { codexLocalHomeName, prepareCodexLocalHome } from './codex-local-home.js';

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 't2107-home-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const SERVER_ID = '5d0b8a51-2c3e-4f6a-9b7c-1e2d3f4a5b6c';
const NO_HOOKS = { hookTrust: async () => [] };
const HASH = `sha256:${'a'.repeat(64)}`;

function memberHome(name: string): string {
  const home = path.join(root, name, '.codex');
  fs.mkdirSync(path.join(home, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(home, 'auth.json'), '{"tokens":{"access_token":"DUMMY"}}');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_provider = "x"\n');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# governance\n');
  return home;
}

test('a sibling home per server, without auth.json or config.toml, governance and sessions linked', async () => {
  const source = memberHome('a');
  const local = await prepareCodexLocalHome(source, SERVER_ID, NO_HOOKS);
  assert.equal(local, path.join(root, 'a', codexLocalHomeName(SERVER_ID)));
  assert.equal(fs.existsSync(path.join(local, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(local, 'config.toml')), false);
  assert.equal(fs.realpathSync(path.join(local, 'sessions')), fs.realpathSync(path.join(source, 'sessions')));
  assert.equal(fs.readFileSync(path.join(local, 'AGENTS.md'), 'utf8'), '# governance\n');
  assert.ok(fs.lstatSync(path.join(local, 'agents')).isSymbolicLink());
});

test('a credential the CLI left behind is removed on the next local spawn', async () => {
  const source = memberHome('b');
  const local = await prepareCodexLocalHome(source, SERVER_ID, NO_HOOKS);
  fs.writeFileSync(path.join(local, 'auth.json'), '{}');
  await prepareCodexLocalHome(source, SERVER_ID, NO_HOOKS);
  assert.equal(fs.existsSync(path.join(local, 'auth.json')), false);
});

test('a real sessions/ dir in the derived home refuses the spawn (transcripts would split)', async () => {
  const source = memberHome('c');
  const local = path.join(root, 'c', codexLocalHomeName(SERVER_ID));
  fs.mkdirSync(path.join(local, 'sessions'), { recursive: true });
  await assert.rejects(prepareCodexLocalHome(source, SERVER_ID, NO_HOOKS), { code: 'CODEX_LOCAL_HOME_FAILED' });
});

test('an invalid server id is refused before any path is built', () => {
  assert.throws(() => codexLocalHomeName('../x'), { code: 'CODEX_LOCAL_HOME_FAILED' });
});

test('qa critical 2: the member hooks.json is linked and trusted by a config.toml that says nothing else', async () => {
  const source = memberHome('d');
  fs.writeFileSync(path.join(source, 'hooks.json'), '{"hooks":{}}');
  const local = await prepareCodexLocalHome(source, SERVER_ID, {
    hookTrust: async (home: string) => [{ key: `${path.join(home, 'hooks.json')}:pre_tool_use:0:0`, hash: HASH }],
  });
  assert.equal(fs.realpathSync(path.join(local, 'hooks.json')), fs.realpathSync(path.join(source, 'hooks.json')));
  const toml = fs.readFileSync(path.join(local, 'config.toml'), 'utf8');
  assert.match(toml, /^\[hooks\.state\."[^"]+hooks\.json:pre_tool_use:0:0"\]\ntrusted_hash = "sha256:a{64}"\n$/u);
  assert.doesNotMatch(toml, /model_provider/u, 'the member config.toml is never copied');
});

test('qa critical 2: member hooks the CLI cannot trust refuse the spawn (never a run without them)', async () => {
  const source = memberHome('e');
  fs.writeFileSync(path.join(source, 'hooks.json'), '{"hooks":{}}');
  await assert.rejects(prepareCodexLocalHome(source, SERVER_ID, NO_HOOKS), { code: 'CODEX_LOCAL_HOME_FAILED' });
  await assert.rejects(prepareCodexLocalHome(source, SERVER_ID, { hookTrust: async () => { throw new Error('x'); } }),
    { code: 'CODEX_LOCAL_HOME_FAILED' });
});

test('qa critical 2: a trust entry for another hooks file is refused', async () => {
  const source = memberHome('f');
  fs.writeFileSync(path.join(source, 'hooks.json'), '{"hooks":{}}');
  await assert.rejects(prepareCodexLocalHome(source, SERVER_ID, {
    hookTrust: async () => [{ key: '/project/.codex/hooks.json:pre_tool_use:0:0', hash: HASH }],
  }), { code: 'CODEX_LOCAL_HOME_FAILED' });
});

test('qa critical 2: a local hooks.json that is not the member\'s refuses the spawn', async () => {
  const source = memberHome('g');
  fs.writeFileSync(path.join(source, 'hooks.json'), '{"hooks":{}}');
  const local = path.join(root, 'g', codexLocalHomeName(SERVER_ID));
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, 'hooks.json'), '{"hooks":{}}');
  await assert.rejects(prepareCodexLocalHome(source, SERVER_ID, { hookTrust: async () => [] }), { code: 'CODEX_LOCAL_HOME_FAILED' });
});
