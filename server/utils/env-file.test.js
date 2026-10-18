/** T-2044 S3: one .env grammar for load-env.js, bootstrap.js and cli.js. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadBootstrapConfiguration } from '../bootstrap.js';

import { applyEnvContent, parseEnvLine } from './env-file.js';

const SERVER_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const FIXTURE = [
  '# comment line',
  '   # indented comment',
  '',
  'PLAIN=value',
  'SPACED = v ',
  'export EXPORTED=yes',
  'EQUALS="a=b"',
  'SINGLE=\'x\'',
  'UNMATCHED="open',
  'MIXED="a\'',
  'INNER=a"b"c',
  'EMPTY=',
  'EMPTY_QUOTED=""',
  'URL=postgres://u:p@h/db?x=1&y=2',
  'NOEQUALS',
  '=novalue',
  'CRLF=line\r',
].join('\n');

const EXPECTED = {
  PLAIN: 'value',
  SPACED: 'v',
  EXPORTED: 'yes',
  EQUALS: 'a=b',
  SINGLE: 'x',
  UNMATCHED: '"open',
  MIXED: '"a\'',
  INNER: 'a"b"c',
  EMPTY: '',
  EMPTY_QUOTED: '',
  URL: 'postgres://u:p@h/db?x=1&y=2',
  CRLF: 'line',
};

test('parseEnvLine: blank, comment, no "=" and empty key lines are ignored', () => {
  for (const line of ['', '   ', '# x=1', '  #y=2', 'NOEQUALS', '=v', ' = v']) {
    assert.equal(parseEnvLine(line), null, JSON.stringify(line));
  }
});

test('parseEnvLine: trims key/value, strips one matching quote pair, keeps inner "="', () => {
  assert.deepEqual(parseEnvLine('KEY = v'), { key: 'KEY', value: 'v' });
  assert.deepEqual(parseEnvLine('KEY="a=b"'), { key: 'KEY', value: 'a=b' });
  assert.deepEqual(parseEnvLine("KEY='x'"), { key: 'KEY', value: 'x' });
  assert.deepEqual(parseEnvLine('KEY="\'x\'"'), { key: 'KEY', value: "'x'" }, 'only one pair');
  assert.deepEqual(parseEnvLine('KEY="'), { key: 'KEY', value: '"' }, 'lone quote kept');
  assert.deepEqual(parseEnvLine('export   KEY=1'), { key: 'KEY', value: '1' });
});

test('applyEnvContent: parses the fixture exactly', () => {
  const env = {};
  applyEnvContent(FIXTURE, env);
  assert.deepEqual(env, EXPECTED);
});

test('applyEnvContent: never overrides a non-empty value; fills an empty one (prior precedence)', () => {
  const env = { PLAIN: 'from-shell', EMPTY: 'set', SPACED: '' };
  applyEnvContent(FIXTURE, env);
  assert.equal(env.PLAIN, 'from-shell');
  assert.equal(env.EMPTY, 'set');
  assert.equal(env.SPACED, 'v');
});

test('parity: bootstrap loader yields the same result as the shared parser', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 't2044-env-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, '.env'), FIXTURE);
  const env = {};
  loadBootstrapConfiguration(root, env);
  assert.deepEqual(env, EXPECTED);
});

test('parity: load-env.js and cli.js delegate to the shared parser (no private grammar)', () => {
  for (const file of ['load-env.js', 'cli.js', 'bootstrap.js']) {
    const source = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
    assert.match(source, /import \{[^}]*applyEnvContent[^}]*\} from '\.\/utils\/env-file\.js'/, file);
    assert.match(source, /applyEnvContent\(/, file);
    assert.doesNotMatch(source, /(?:envFile|content)\.split\('\\n'\)/, `${file} must not parse lines itself`);
  }
});

test('cli.js reuses the canonical default database path', () => {
  const source = fs.readFileSync(path.join(SERVER_DIR, 'cli.js'), 'utf8');
  assert.match(source, /import \{ DEFAULT_DATABASE_PATH \} from '\.\/modules\/database\/database-path\.js'/);
  assert.doesNotMatch(source, /const DEFAULT_DATABASE_PATH/);
});
