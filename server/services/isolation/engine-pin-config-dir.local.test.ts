/**
 * ADR-227 / T-2098 stage 3a — the credential-free config dir of a LOCAL-engine
 * spawn: its own derived dir per local server (so the CLI's model caches never
 * mix with the kimi/glm dir or another server's), and a user-scope settings env
 * block that cannot re-route or re-model the run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import { DERIVED_DIR_NAME, localEngineDerivedDirName, prepareEnginePinConfigDir } from './engine-pin-config-dir.js';

let root: string;
let source: string;
let operatorHome: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-pin-local-'));
  source = path.join(root, 'user', '.claude');
  operatorHome = path.join(root, 'operator');
  fs.mkdirSync(path.join(source, 'projects'), { recursive: true });
  fs.mkdirSync(operatorHome, { recursive: true });
  fs.writeFileSync(path.join(source, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"SYNTHETIC_ONLY_ACCESS_TOKEN"}}');
  fs.writeFileSync(path.join(source, 'settings.json'), JSON.stringify({
    theme: 'dark',
    env: { ANTHROPIC_MODEL: 'claude-opus-5', ANTHROPIC_BASE_URL: 'https://api.anthropic.com', DISABLE_TELEMETRY: '1' },
  }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('a local server gets its own derived dir, never the shared vendor-engine one', async () => {
  const name = localEngineDerivedDirName('0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11');
  assert.equal(name, '.claude-engine-local-0b9c6a3e6f1e4c419a4e2f1b9e0c7d11');
  assert.notEqual(name, DERIVED_DIR_NAME);
  assert.throws(() => localEngineDerivedDirName('../escape'));

  const dir = await prepareEnginePinConfigDir({ CLAUDE_CONFIG_DIR: source }, {
    operatorHome, derivedName: name, stripEnvKeys: ['ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL'],
  });
  assert.equal(dir, path.join(root, 'user', name));
  assert.equal(fs.existsSync(path.join(dir, '.credentials.json')), false);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.theme, 'dark');
  assert.deepEqual(settings.env, { DISABLE_TELEMETRY: '1' });
  assert.equal(fs.realpathSync(path.join(dir, 'projects')), fs.realpathSync(path.join(source, 'projects')));

  const other = await prepareEnginePinConfigDir({ CLAUDE_CONFIG_DIR: source }, {
    operatorHome, derivedName: localEngineDerivedDirName('ffffffff-0000-4000-8000-000000000000'),
  });
  assert.notEqual(other, dir, 'two local servers never share caches');
});

test('the vendor-engine dir is unchanged when no option is passed', async () => {
  const dir = await prepareEnginePinConfigDir({ CLAUDE_CONFIG_DIR: source }, { operatorHome });
  assert.equal(path.basename(dir), DERIVED_DIR_NAME);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  assert.equal(settings.env.ANTHROPIC_MODEL, 'claude-opus-5');
});

test('a private entry is a real dir of its own, never a link into the member tree', async () => {
  const plugins = path.join(source, 'plugins');
  fs.mkdirSync(path.join(plugins, 'cache'), { recursive: true });
  fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), '{"plugins":{}}');
  const name = localEngineDerivedDirName('0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11');
  const derived = path.join(root, 'user', name);
  // A derived dir built before the fix still holds the old link.
  fs.mkdirSync(derived, { recursive: true });
  fs.symlinkSync(plugins, path.join(derived, 'plugins'));

  const dir = await prepareEnginePinConfigDir({ CLAUDE_CONFIG_DIR: source }, {
    operatorHome, derivedName: name, privateEntries: ['plugins'],
  });
  const stat = fs.lstatSync(path.join(dir, 'plugins'));
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'plugins/ is private to the local dir');
  fs.writeFileSync(path.join(dir, 'plugins', 'written-by-local-run'), 'x');
  assert.equal(fs.existsSync(path.join(plugins, 'written-by-local-run')), false);
  assert.equal(fs.readFileSync(path.join(plugins, 'installed_plugins.json'), 'utf8'), '{"plugins":{}}');
  assert.ok(fs.lstatSync(path.join(dir, 'projects')).isSymbolicLink(), 'other entries stay linked');
});
