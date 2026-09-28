import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectClaudeHome, resolveCoreDir } from './lib/doctor-claude-home.mjs';

const LIB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'doctor-claude-home.mjs');
const ENV = { NASSAJ_GOVERNANCE_DIR: '' };

/** Temp HOME with a governance checkout at ~/nassaj-core (has .git, sync.sh, baseline settings). */
function makeHome(t) {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'doctor-claude-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const core = path.join(home, 'nassaj-core');
  fs.mkdirSync(path.join(core, '.git', 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(core, 'sync.sh'), '#!/bin/sh\n');
  fs.writeFileSync(path.join(core, 'NASSAJ.md'), 'x\n');
  fs.writeFileSync(path.join(core, 'settings.json'), JSON.stringify({ hooks: { a: [1, 2] }, env: { B: '1' }, model: 'x' }));
  return { home, core, claudeHome: path.join(home, '.claude') };
}

/** Separated layout: real ~/.claude with a NASSAJ.md link and a runtime settings file. */
function separate({ core, claudeHome }, settings = { env: { B: '1' }, hooks: { a: [1, 2] }, model: 'y' }) {
  fs.mkdirSync(claudeHome);
  fs.symlinkSync(path.join(core, 'NASSAJ.md'), path.join(claudeHome, 'NASSAJ.md'));
  fs.writeFileSync(path.join(claudeHome, 'settings.json'), JSON.stringify(settings));
}

const byName = (findings) => Object.fromEntries(findings.map((f) => [f.name, f]));

test('missing ~/.claude is ok', (t) => {
  const { home } = makeHome(t);
  assert.deepEqual(inspectClaudeHome({ home, env: ENV }).map((f) => f.level), ['ok']);
});

test('legacy whole-dir symlink and runtime inside governance warn', (t) => {
  const { home, core, claudeHome } = makeHome(t);
  fs.symlinkSync(core, claudeHome);
  fs.writeFileSync(path.join(core, '.credentials.json'), '{}');
  fs.mkdirSync(path.join(core, 'sessions'));
  const findings = byName(inspectClaudeHome({ home, env: ENV }));
  assert.equal(findings['Claude home layout'].level, 'warn');
  assert.match(findings['Claude home layout'].detail, /legacy/);
  assert.match(findings['Claude runtime in governance'].detail, /\.credentials\.json, sessions/);
  assert.equal(findings['Claude settings drift'], undefined, 'legacy layout has one settings file');
});

test('clean separated layout: ok, key order and host-local keys ignored', (t) => {
  const fixture = makeHome(t);
  separate(fixture);
  fs.symlinkSync(path.join(fixture.core, 'sessions-missing'), path.join(fixture.core, 'sessions'));
  const findings = inspectClaudeHome({ home: fixture.home, env: ENV });
  assert.deepEqual(findings.map((f) => [f.name, f.level]), [['Claude home layout', 'ok']]);
});

test('links into .git, sync.sh or setup.sh are reported (depth 2)', (t) => {
  const fixture = makeHome(t);
  separate(fixture);
  fs.symlinkSync(path.join(fixture.core, 'sync.sh'), path.join(fixture.claudeHome, 'sync.sh'));
  fs.mkdirSync(path.join(fixture.claudeHome, 'nested'));
  fs.symlinkSync(path.join(fixture.core, '.git', 'hooks'), path.join(fixture.claudeHome, 'nested', 'hooks'));
  fs.symlinkSync(path.join(fixture.core, 'setup.sh'), path.join(fixture.claudeHome, 'dangling-setup'));
  const detail = byName(inspectClaudeHome({ home: fixture.home, env: ENV }))['Claude home links'].detail;
  assert.match(detail, /sync\.sh ->/);
  assert.match(detail, /nested\/hooks -> .*\.git/);
  assert.match(detail, /dangling-setup -> .*setup\.sh/);
});

test('settings drift names the baseline-owned keys that differ', (t) => {
  const fixture = makeHome(t);
  separate(fixture, { hooks: { a: [2, 1] }, env: { B: '1' }, model: 'y' });
  assert.match(byName(inspectClaudeHome({ home: fixture.home, env: ENV }))['Claude settings drift'].detail, /: hooks$/);
});

test('manifest settingsOwners.baseline overrides the default key list', (t) => {
  const fixture = makeHome(t);
  separate(fixture, { hooks: { a: [9] }, env: { B: '1' }, model: 'z' });
  fs.writeFileSync(path.join(fixture.core, 'claude-home.manifest'), JSON.stringify({ settingsOwners: { baseline: ['model'] } }));
  assert.match(byName(inspectClaudeHome({ home: fixture.home, env: ENV }))['Claude settings drift'].detail, /: model$/);
});

test('core dir resolution: env override, NASSAJ.md link, default', (t) => {
  const fixture = makeHome(t);
  assert.equal(resolveCoreDir(fixture.home, { NASSAJ_GOVERNANCE_DIR: '/x/y' }), '/x/y');
  assert.equal(resolveCoreDir(fixture.home, ENV), path.join(fixture.home, 'nassaj-core'));
  separate(fixture);
  assert.equal(resolveCoreDir(fixture.home, ENV), fs.realpathSync(fixture.core));
});

test('the inspector holds no writer primitive (read-only contract is structural)', () => {
  const source = fs.readFileSync(LIB, 'utf8');
  assert.doesNotMatch(source, /\b(writeFile|appendFile|rename|unlink|symlink|mkdir|rmSync|rm\(|copyFile|chmod|chown)\w*\(/);
});

test('L6: a link that vanishes between listing and readlink is skipped, not thrown', (t) => {
  const fixture = makeHome(t);
  separate(fixture);
  const readlink = t.mock.method(fs, 'readlinkSync', () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); });
  fs.symlinkSync(path.join(fixture.home, 'missing', 'sync.sh'), path.join(fixture.claudeHome, 'racy'));
  const findings = inspectClaudeHome({ home: fixture.home, env: ENV });
  assert.ok(readlink.mock.callCount() > 0);
  assert.equal(byName(findings)['Claude home links'], undefined);
});
