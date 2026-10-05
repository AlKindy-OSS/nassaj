/**
 * project-board-reader — B-1524.
 *
 * Every reason code, real filesystem fixtures under /var/tmp (never tmpfs):
 * awkward root names, symlinks in and out of the project, parent-directory
 * swaps, hard links, FIFOs, directories, device targets, size caps, encoding,
 * the governance stub, external bindings, and the parsed-state cache.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test, { after } from 'node:test';

import {
  ARCHITECTURE_AR_FILE,
  ARCHITECTURE_FILE,
  BOARD_STATE_FILE,
  STATE_MAX_BYTES,
  __test__,
  getExternalBinding,
  isExternalStatePath,
  parseExternalBindings,
  readProjectBoardState,
  readProjectFile,
} from './project-board-reader.js';

const FIXTURE_PARENT = fs.existsSync('/var/tmp') ? '/var/tmp' : path.dirname(process.cwd());
const fixtureRoot = fs.mkdtempSync(path.join(FIXTURE_PARENT, 'b1524-reader-'));
after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));

let counter = 0;
function makeProject(name = `project-${counter += 1}`): string {
  const root = path.join(fixtureRoot, name);
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  return root;
}

function writeState(root: string, value: unknown): string {
  const file = path.join(root, BOARD_STATE_FILE);
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

function outsideFile(name: string, content: string): string {
  const dir = path.join(fixtureRoot, `outside-${counter += 1}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

test('ok: plain project reads state and architecture', () => {
  const root = makeProject();
  writeState(root, { tasks: [{ id: 'T-1' }] });
  fs.writeFileSync(path.join(root, ARCHITECTURE_FILE), '# arch\n');
  const state = readProjectBoardState(root);
  assert.equal(state.status, 'ok');
  assert.deepEqual(state.value, { tasks: [{ id: 'T-1' }] });
  assert.equal(readProjectFile(root, ARCHITECTURE_FILE).content, '# arch\n');
});

test('root with spaces, Arabic, @ and + is fine', () => {
  const root = makeProject('مشروع تجريبي @v1+x');
  writeState(root, { tasks: [] });
  fs.writeFileSync(path.join(root, ARCHITECTURE_AR_FILE), '# المعمارية\n');
  assert.equal(readProjectBoardState(root).status, 'ok');
  assert.equal(readProjectFile(root, ARCHITECTURE_AR_FILE).content, '# المعمارية\n');
});

test('root reached through a symlinked ancestor is fine', () => {
  const real = makeProject();
  writeState(real, { tasks: [] });
  const alias = path.join(fixtureRoot, `alias-${counter += 1}`);
  fs.symlinkSync(real, alias);
  assert.equal(readProjectBoardState(alias).status, 'ok');
});

test('missing: absent file, absent root, relative root, dangling symlink', () => {
  const root = makeProject();
  assert.equal(readProjectBoardState(root).status, 'missing');
  assert.equal(readProjectBoardState(path.join(root, 'nope')).status, 'missing');
  assert.equal(readProjectBoardState('relative/root').status, 'missing');
  fs.symlinkSync(path.join(root, 'docs', 'gone.json'), path.join(root, BOARD_STATE_FILE));
  assert.equal(readProjectBoardState(root).status, 'missing');
});

test('empty file reads as missing (state and architecture)', () => {
  const root = makeProject();
  writeState(root, '');
  fs.writeFileSync(path.join(root, ARCHITECTURE_FILE), '');
  assert.equal(readProjectBoardState(root).status, 'missing');
  assert.equal(readProjectFile(root, ARCHITECTURE_FILE).status, 'missing');
});

test('invalid_json', () => {
  const root = makeProject();
  writeState(root, '{not json');
  assert.equal(readProjectBoardState(root).status, 'invalid_json');
});

test('invalid_json: valid JSON that is not a plain object', () => {
  const root = makeProject();
  for (const body of ['"x"', '[]', 'null', '42', 'true']) {
    writeState(root, body);
    assert.equal(readProjectBoardState(root).status, 'invalid_json', body);
  }
});

test('external_source_unconfigured: the governance boundary stub', () => {
  const root = makeProject();
  writeState(root, {
    $schema: 'nassaj-governance-boundary/v1', available: false,
    reason: 'governance_provider_required', sourceOfTruth: 'nassaj-core',
  });
  assert.equal(readProjectBoardState(root).status, 'external_source_unconfigured');
});

test('too_large: over the cap; near-cap warns once', () => {
  const root = makeProject();
  writeState(root, JSON.stringify({ pad: 'x'.repeat(200) }));
  assert.equal(readProjectBoardState(root, { maxBytes: 100 }).status, 'too_large');
  assert.equal(readProjectFile(root, BOARD_STATE_FILE, { maxBytes: 100 }).status, 'too_large');
  const warnings: unknown[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    __test__.resetWarnings();
    const size = fs.statSync(path.join(root, BOARD_STATE_FILE)).size;
    readProjectBoardState(root, { maxBytes: size + 1 });
    readProjectBoardState(root, { maxBytes: size + 1 });
  } finally {
    console.warn = original;
  }
  assert.equal(warnings.length, 1, 'warn once per file above 75% of the cap');
  assert.ok(STATE_MAX_BYTES === 16 * 1024 * 1024);
});

test('unreadable: invalid UTF-8', () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, ARCHITECTURE_FILE), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  assert.equal(readProjectFile(root, ARCHITECTURE_FILE).status, 'unreadable');
});

test('symlink to a file inside the project is allowed', () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, 'board'));
  fs.writeFileSync(path.join(root, 'board', 'state.json'), JSON.stringify({ tasks: [] }));
  fs.symlinkSync('../board/state.json', path.join(root, BOARD_STATE_FILE));
  assert.equal(readProjectBoardState(root).status, 'ok');
});

test('outside_project: symlink to a home-like file outside the project', () => {
  const root = makeProject();
  const secret = outsideFile('settings.json', JSON.stringify({ token: 'nope' }));
  fs.symlinkSync(secret, path.join(root, BOARD_STATE_FILE));
  fs.symlinkSync(secret, path.join(root, ARCHITECTURE_FILE));
  assert.equal(readProjectBoardState(root).status, 'outside_project');
  assert.equal(readProjectFile(root, ARCHITECTURE_FILE).status, 'outside_project');
});

test('outside_project: /dev/null target', () => {
  const root = makeProject();
  fs.symlinkSync('/dev/null', path.join(root, ARCHITECTURE_FILE));
  assert.equal(readProjectFile(root, ARCHITECTURE_FILE).status, 'outside_project');
});

test('outside_project: parent directory swapped for a symlink to outside', () => {
  const root = makeProject();
  writeState(root, { tasks: [{ id: 'INSIDE' }] });
  assert.equal(readProjectBoardState(root).status, 'ok');
  const outside = path.dirname(outsideFile('project-state.json', JSON.stringify({ tasks: [{ id: 'OUT' }] })));
  fs.renameSync(path.join(root, 'docs'), path.join(root, 'docs-old'));
  fs.symlinkSync(outside, path.join(root, 'docs'));
  assert.equal(readProjectBoardState(root).status, 'outside_project');
});

test('outside_project: a relative path outside the fixed set is refused', () => {
  const root = makeProject();
  assert.equal(readProjectFile(root, '../etc/passwd').status, 'outside_project');
});

test('unreadable: hard link (nlink > 1)', () => {
  const root = makeProject();
  const outside = outsideFile('linked.json', JSON.stringify({ tasks: [] }));
  fs.linkSync(outside, path.join(root, BOARD_STATE_FILE));
  assert.equal(readProjectBoardState(root).status, 'unreadable');
});

test('unreadable: FIFO is refused without blocking', () => {
  const root = makeProject();
  execFileSync('mkfifo', [path.join(root, BOARD_STATE_FILE)]);
  const started = Date.now();
  assert.equal(readProjectBoardState(root).status, 'unreadable');
  assert.ok(Date.now() - started < 2000, 'must not block on the FIFO');
});

test('unreadable: directory in place of the file', () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, BOARD_STATE_FILE));
  assert.equal(readProjectBoardState(root).status, 'unreadable');
});

test('bindings: parse validates format only, drops malformed entries', () => {
  const bound = outsideFile('bound.json', JSON.stringify({ tasks: [] }));
  const original = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    const map = parseExternalBindings(
      ` 3f0c4d2e-1111-4222-8333-444455556666=${bound}, bad, x=relative/path, y=/no/such/file,=${bound}`,
    );
    assert.equal(map.size, 2);
    assert.equal(map.get('3f0c4d2e-1111-4222-8333-444455556666'), bound);
    assert.equal(map.get('y'), '/no/such/file', 'existence is judged per lookup, not at parse');
    assert.equal(warnings.length, 3);
    assert.ok(warnings.every((w) => !String(w).includes(bound)), 'never log the path');
  } finally {
    console.warn = original;
  }
  assert.equal(parseExternalBindings(undefined).size, 0);
  assert.equal(parseExternalBindings('').size, 0);
});

test('bindings: getExternalBinding reads the env and re-parses on change', () => {
  const bound = outsideFile('env-bound.json', JSON.stringify({ tasks: [] }));
  __test__.resetBindings();
  assert.equal(getExternalBinding('p-1', {}), null);
  assert.equal(getExternalBinding('p-1', { NASSAJ_BOARD_EXTERNAL_BINDINGS: `p-1=${bound}` }), fs.realpathSync(bound));
  assert.equal(getExternalBinding('p-2', { NASSAJ_BOARD_EXTERNAL_BINDINGS: `p-1=${bound}` }), null);
  assert.equal(getExternalBinding(undefined as never, {}), null);
});

test('bindings: a file missing at first lookup and a re-pointed symlink resolve live', () => {
  __test__.resetBindings();
  const dir = path.dirname(outsideFile('placeholder', ''));
  const link = path.join(dir, 'bound-link.json');
  const env = { NASSAJ_BOARD_EXTERNAL_BINDINGS: `p-live=${link}` };
  assert.equal(getExternalBinding('p-live', env), null, 'missing file ⇒ no binding yet');
  const first = path.join(dir, 'first.json');
  const second = path.join(dir, 'second.json');
  fs.writeFileSync(first, '{}');
  fs.writeFileSync(second, '{}');
  fs.symlinkSync(first, link);
  assert.equal(getExternalBinding('p-live', env), fs.realpathSync(first), 'appears once created');
  fs.rmSync(link);
  fs.symlinkSync(second, link);
  assert.equal(getExternalBinding('p-live', env), fs.realpathSync(second), 'follows the re-pointed link');
});

test('binding match: the bound file is accepted through the project symlink', () => {
  const rootA = makeProject();
  const bound = outsideFile('project-state.json', JSON.stringify({ tasks: [{ id: 'BOUND' }] }));
  fs.symlinkSync(bound, path.join(rootA, BOARD_STATE_FILE));
  const read = readProjectBoardState(rootA, { externalBinding: fs.realpathSync(bound) });
  assert.equal(read.status, 'ok');
  assert.deepEqual(read.value, { tasks: [{ id: 'BOUND' }] });
  assert.equal(isExternalStatePath(read.realPath, read.rootReal), true);
  assert.equal(readProjectBoardState(rootA).status, 'outside_project', 'no binding ⇒ refused');
});

test('binding mismatch: project B symlinking to A\'s bound file is refused', () => {
  const rootB = makeProject();
  const boundA = outsideFile('project-state.json', JSON.stringify({ tasks: [{ id: 'A-ONLY' }] }));
  const boundB = outsideFile('project-state.json', JSON.stringify({ tasks: [{ id: 'B' }] }));
  fs.symlinkSync(boundA, path.join(rootB, BOARD_STATE_FILE));
  const read = readProjectBoardState(rootB, { externalBinding: fs.realpathSync(boundB) });
  assert.equal(read.status, 'outside_project');
});

test('binding never applies to the architecture documents', () => {
  const root = makeProject();
  const bound = outsideFile('ARCHITECTURE.md', '# outside\n');
  fs.symlinkSync(bound, path.join(root, ARCHITECTURE_FILE));
  const read = readProjectFile(root, ARCHITECTURE_FILE, { externalBinding: fs.realpathSync(bound) });
  assert.equal(read.status, 'outside_project');
});

test('cache: same version is served from cache, a stat change re-parses', () => {
  const root = makeProject();
  const file = writeState(root, { tasks: [{ id: 'V1' }] });
  const first = readProjectBoardState(root);
  assert.equal(__test__.stateCache.get(first.realPath)?.key, __test__.statKey(first.stat), 'miss populates');
  const second = readProjectBoardState(root);
  assert.equal(second.value, first.value, 'cache hit returns the same parsed object');
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'V2-longer' }] }));
  const third = readProjectBoardState(root);
  assert.notEqual(third.value, first.value);
  assert.deepEqual(third.value, { tasks: [{ id: 'V2-longer' }] });
});

test('cache: repeated writes to one file keep exactly one entry for it', () => {
  const root = makeProject();
  const file = writeState(root, { tasks: [] });
  const before = __test__.stateCache.size;
  let realPath = '';
  for (let version = 0; version < 10; version += 1) {
    fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: `V${version}`, pad: 'x'.repeat(version) }] }));
    const read = readProjectBoardState(root);
    assert.deepEqual((read.value as { tasks: Array<{ id: string }> }).tasks[0].id, `V${version}`);
    realPath = read.realPath as string;
  }
  assert.equal(__test__.stateCache.size, before + 1, 'old versions are replaced, not accumulated');
  assert.ok((__test__.stateCache.get(realPath)?.bytes ?? 0) > 0, 'entry carries its byte estimate');
});

test('isExternalStatePath: inside vs outside vs junk', () => {
  assert.equal(isExternalStatePath('/a/b/docs/x.json', '/a/b'), false);
  assert.equal(isExternalStatePath('/a/bc/docs/x.json', '/a/b'), true);
  assert.equal(isExternalStatePath(undefined as never, '/a'), false);
});
