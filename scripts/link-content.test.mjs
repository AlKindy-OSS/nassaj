import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'link-content.sh');

test('materializes only verified agent entrypoints as regular 0444 files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'link-content-'));
  const core = path.join(root, 'core');
  const home = path.join(root, 'home');
  const product = path.join(root, 'product');
  fs.mkdirSync(core);
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(product, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(product, 'docs'));
  fs.copyFileSync(SOURCE, path.join(product, 'scripts', 'link-content.sh'));
  fs.chmodSync(path.join(product, 'scripts', 'link-content.sh'), 0o755);

  fs.writeFileSync(path.join(core, 'AGENTS.md'), 'agents\n');
  fs.writeFileSync(path.join(core, 'GEMINI.md'), 'gemini\n');
  execFileSync('git', ['-C', core, 'init', '-q']);
  execFileSync('git', ['-C', core, 'config', 'user.email', 'test@nassaj.local']);
  execFileSync('git', ['-C', core, 'config', 'user.name', 'test']);
  execFileSync('git', ['-C', core, 'add', 'AGENTS.md', 'GEMINI.md']);
  execFileSync('git', ['-C', core, 'commit', '-qm', 'test: manifest']);
  fs.symlinkSync(core, path.join(home, '.claude'), 'dir');

  for (const name of ['ARCHITECTURE.md', 'ARCHITECTURE_AR.md', 'project-state.json']) {
    const target = path.join(root, `sentinel-${name}`);
    fs.writeFileSync(target, 'untouched\n');
    fs.symlinkSync(target, path.join(product, 'docs', name));
  }
  fs.symlinkSync(path.join(core, 'AGENTS.md'), path.join(product, 'AGENTS.md'));
  fs.symlinkSync(path.join(core, 'GEMINI.md'), path.join(product, 'GEMINI.md'));
  const coreBefore = new Map(['AGENTS.md', 'GEMINI.md'].map((name) => [
    name,
    fs.readFileSync(path.join(core, name)),
  ]));

  execFileSync('bash', [path.join(product, 'scripts', 'link-content.sh')], {
    cwd: product,
    env: { ...process.env, HOME: home },
  });

  for (const name of ['AGENTS.md', 'GEMINI.md']) {
    const stat = fs.lstatSync(path.join(product, name));
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.mode & 0o777, 0o444);
    assert.equal(fs.readFileSync(path.join(product, name), 'utf8'), fs.readFileSync(path.join(core, name), 'utf8'));
    assert.deepEqual(fs.readFileSync(path.join(core, name)), coreBefore.get(name));
  }
  for (const name of ['ARCHITECTURE.md', 'ARCHITECTURE_AR.md', 'project-state.json']) {
    assert.equal(fs.lstatSync(path.join(product, 'docs', name)).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(path.join(product, 'docs', name), 'utf8'), 'untouched\n');
  }
});

test('contains a manifest guard and no destructive content-link cleanup', () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.doesNotMatch(source, /rm\s+-rf/);
  assert.doesNotMatch(source, /docs\/ARCHITECTURE|project-state\.json/);
  assert.match(source, /hash-object/);
});
