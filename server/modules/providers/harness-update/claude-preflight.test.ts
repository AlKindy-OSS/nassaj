/**
 * claude-preflight.test — ADR-215 stage B pre-run facts: system copies and
 * the npm-global claude the vendor's `claude install` would uninstall.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { detectNpmGlobalClaude, existingSystemCopies, npmGlobalPrefixes, npmrcPrefix } from './claude-preflight.js';

const ROOT = fs.mkdtempSync(path.join('/var/tmp', 'claude-preflight-test-'));
after(() => {
  fs.chmodSync(path.join(ROOT, 'ro', 'lib', 'node_modules', '@anthropic-ai'), 0o755);
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function pkg(prefix: string): string {
  const dir = path.join(ROOT, prefix, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('system copies: only existing paths are reported (a dangling link counts)', () => {
  const file = path.join(ROOT, 'claude-file');
  const dangling = path.join(ROOT, 'claude-link');
  fs.writeFileSync(file, 'x');
  fs.symlinkSync(path.join(ROOT, 'nowhere'), dangling);
  assert.deepEqual(existingSystemCopies([file, dangling, path.join(ROOT, 'absent')]), [file, dangling]);
});

test('npmrc prefix: ~, ${HOME} and quotes expand; relative or missing is null', () => {
  const home = path.join(ROOT, 'home');
  fs.mkdirSync(home, { recursive: true });
  assert.equal(npmrcPrefix(home), null);
  for (const [line, want] of [
    ['prefix=~/.npm-global', path.join(home, '.npm-global')],
    ['prefix = "${HOME}/g"', path.join(home, 'g')],
    ['  prefix=/opt/npm  ', '/opt/npm'],
    ['prefix=relative/dir', null],
  ] as const) {
    fs.writeFileSync(path.join(home, '.npmrc'), `registry=https://r\n${line}\n`);
    assert.equal(npmrcPrefix(home), want, line);
  }
});

test('global prefixes: the npmrc prefix first, then the prefix of each node on the fixed PATH', () => {
  const home = path.join(ROOT, 'home2');
  fs.mkdirSync(path.join(ROOT, 'nodeprefix', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'nodeprefix', 'bin', 'node'), '');
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.npmrc'), 'prefix=/opt/npm\n');
  assert.deepEqual(npmGlobalPrefixes(home, [path.join(ROOT, 'nodeprefix', 'bin', 'node'), path.join(ROOT, 'none')]),
    ['/opt/npm', path.join(ROOT, 'nodeprefix')]);
});

test('npm-global claude: found only under a prefix this uid can write', () => {
  assert.equal(detectNpmGlobalClaude([path.join(ROOT, 'empty')]), null);
  const writable = pkg('rw');
  assert.deepEqual(detectNpmGlobalClaude([path.join(ROOT, 'empty'), path.join(ROOT, 'rw')]), { packageDir: writable });
  pkg('ro');
  fs.chmodSync(path.join(ROOT, 'ro', 'lib', 'node_modules', '@anthropic-ai'), 0o555);
  const expected = process.getuid?.() === 0 ? { packageDir: path.join(ROOT, 'ro', 'lib', 'node_modules', '@anthropic-ai', 'claude-code') } : null;
  assert.deepEqual(detectNpmGlobalClaude([path.join(ROOT, 'ro')]), expected);
});
