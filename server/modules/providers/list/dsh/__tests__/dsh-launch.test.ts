/**
 * dsh-launch.test — the pure builders and checks of the dsh launch seam
 * (T-2086 S2, ADR-224). The ordered seam end to end (gate, governance, spawn)
 * is covered by dsh-acceptance.test.ts.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DSH_CHILD_PATH, DSH_ENV_ALLOW_LIST, DSH_LAUNCH_ERROR, DSH_MIN_NODE_VERSION,
  assertExactDshEnv, assertNodeScript, buildDshLaunchArgv, buildDshLaunchEnv, ensureRealDirectory,
  isSupportedNodeVersion, nassajDshLayerPath, nassajDshPolicyPluginPath, resetDshUserLayers, resolveDshNode,
  verifyNassajDshLayer, verifyNassajDshPolicyPlugin,
} from '../dsh-launch.js';
import { assertDshOverrideSemantics } from '../dsh-dump-config-check.js';

import { DSH_LLM_ROW, DSH_PUBLIC_BASE_URL, DSH_TELEMETRY_ROW, DSH_UPLOAD_ROWS, readPatchLayer } from './dsh-patch-layer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-dsh-launch-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const HOSTILE = {
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'sk-ant', ANTHROPIC_BASE_URL: 'http://x',
  XDG_CONFIG_HOME: '/op/.config', NODE_OPTIONS: '--require /op/p.js', JWT_SECRET: 'jwt', PATH: '/home/op/.nvm/bin',
  DEEPSEEK_API_KEY: 'sk-operator', LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
};
const codeOf = (code: string) => ({ code });

describe('the child env is an exact allow-list built from scratch', () => {
  const home = '/srv/users/7';
  const env = buildDshLaunchEnv({ home, apiKey: 'sk-member', serverEnv: HOSTILE });

  it('holds exactly the allow-list, with the member\'s values', () => {
    assert.deepEqual(Object.keys(env).sort(), [...DSH_ENV_ALLOW_LIST]);
    assert.deepEqual(env, {
      PATH: DSH_CHILD_PATH, HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color', TMPDIR: `${home}/.tmp`,
      DSH_HOME: `${home}/.dsh`, DSH_AGENTS_HOME: `${home}/.agents`, DEEPSEEK_API_KEY: 'sk-member',
      DSH_TELEMETRY_DISABLED: '1',
    });
    assert.equal(DSH_CHILD_PATH, '/usr/local/bin:/usr/bin:/bin');
  });

  it('falls back to safe LANG/TERM when the server values are missing or odd', () => {
    const fallback = buildDshLaunchEnv({ home, apiKey: 'k', serverEnv: { LANG: 'x;rm -rf /', TERM: undefined } });
    assert.equal(fallback.LANG, 'C.UTF-8');
    assert.equal(fallback.TERM, 'dumb');
  });

  it('assertExactDshEnv refuses an extra, a missing or an empty variable', () => {
    assert.deepEqual(assertExactDshEnv({ ...env }), env);
    assert.throws(() => assertExactDshEnv({ ...env, DEEPSEEK_BASE_URL: 'http://x' }), codeOf(DSH_LAUNCH_ERROR.ENV_NOT_EXACT));
    const { TERM: _term, ...missing } = env;
    assert.throws(() => assertExactDshEnv(missing), codeOf(DSH_LAUNCH_ERROR.ENV_NOT_EXACT));
    assert.throws(() => assertExactDshEnv({ ...env, DEEPSEEK_API_KEY: '' }), codeOf(DSH_LAUNCH_ERROR.ENV_NOT_EXACT));
  });
});

describe('argv and the Nassaj patch layer', () => {
  it('re-derives nassaj-acp from acp and passes the Nassaj layer LAST', () => {
    const argv = buildDshLaunchArgv('/app/server/governance/dsh-nassaj-layer.yml');
    assert.deepEqual(argv, ['nassaj-acp', '--from-default-profile', 'acp', '--patch',
      '/app/server/governance/dsh-nassaj-layer.yml']);
    assert.equal(argv.filter((arg) => arg === '--patch').length, 1, 'T-2091: one Nassaj layer, no no-subagent layer');
  });

  it('the policy plugin dir matches its pins; an altered copy or a symlinked file is refused (T-2091)', () => {
    assert.equal(verifyNassajDshPolicyPlugin(), nassajDshPolicyPluginPath());
    for (const file of ['index.mjs', 'package.json']) {
      const copy = fs.mkdtempSync(path.join(scratch, 'plugin-'));
      fs.cpSync(nassajDshPolicyPluginPath(), copy, { recursive: true });
      fs.appendFileSync(path.join(copy, file), file === 'index.mjs' ? '\n// planted\n' : '\n');
      assert.throws(() => verifyNassajDshPolicyPlugin(copy), codeOf(DSH_LAUNCH_ERROR.POLICY_PLUGIN_UNTRUSTED));
    }
    const linked = fs.mkdtempSync(path.join(scratch, 'plugin-link-'));
    fs.copyFileSync(path.join(nassajDshPolicyPluginPath(), 'package.json'), path.join(linked, 'package.json'));
    fs.symlinkSync(path.join(nassajDshPolicyPluginPath(), 'index.mjs'), path.join(linked, 'index.mjs'));
    assert.throws(() => verifyNassajDshPolicyPlugin(linked), codeOf(DSH_LAUNCH_ERROR.POLICY_PLUGIN_UNTRUSTED));
  });

  it('a DSH_PATH override must carry every security row in its dump-config (recorded on real dsh, T-2091)', () => {
    const recorded = fs.readFileSync(path.join(here, 'fixtures', 'dsh-dump-config.recorded.txt'), 'utf8');
    const script = path.join(scratch, 'override-dsh.js');
    fs.writeFileSync(script, `// override ${Math.random()}\n`);
    const launch = { command: process.execPath, args: [script], env: {}, home: scratch, script };
    const calls: string[][] = [];
    const run = (stdout: string) => (_cmd: string, args: string[]) => { calls.push(args); return { status: 0, stdout }; };
    assertDshOverrideSemantics(launch, {}, { run: run('') as never });
    assert.equal(calls.length, 0, 'no override: nothing runs');
    assertDshOverrideSemantics(launch, { DSH_PATH: script }, { run: run(recorded) as never });
    assert.equal(calls.at(-1)?.at(-1), '--dump-config');
    const other = path.join(scratch, 'override-dsh-2.js');
    fs.writeFileSync(other, '// another binary\n');
    const renamed = recorded.replace('- id: session-log-deepseek', '- id: session-log-deepseek-v2');
    assert.throws(() => assertDshOverrideSemantics({ ...launch, script: other }, { DSH_PATH: other }, { run: run(renamed) as never }),
      codeOf(DSH_LAUNCH_ERROR.OVERRIDE_UNVERIFIED));
  });

  it('the shipped layer disables every upload, account, plugin and telemetry row and pins the origin', () => {
    const layer = new Map(readPatchLayer(nassajDshLayerPath()).map((entry: Record<string, unknown>) => [entry.id, entry]));
    for (const id of ['llm-pi-ai', 'deepseek-account', 'llm-deepseek-account', 'plugin-manager', 'tool-plugin-manager',
      DSH_TELEMETRY_ROW, ...DSH_UPLOAD_ROWS]) {
      assert.equal(layer.get(id)?.disabled, true, id);
    }
    assert.equal(layer.get(DSH_LLM_ROW)?.baseURL, DSH_PUBLIC_BASE_URL);
    for (const entry of readPatchLayer(path.join(here, 'fixtures', 'nassaj-dsh-layer.reference.yml'))) {
      assert.deepEqual(layer.get(entry.id), entry, `reference entry ${entry.id}`);
    }
  });

  it('the shipped layer matches its pin; an altered copy or a symlink is refused', () => {
    assert.equal(verifyNassajDshLayer(), nassajDshLayerPath());
    const altered = path.join(scratch, 'altered.yml');
    fs.writeFileSync(altered, `${fs.readFileSync(nassajDshLayerPath(), 'utf8')}- id: x\n`);
    assert.throws(() => verifyNassajDshLayer(altered), codeOf(DSH_LAUNCH_ERROR.LAYER_UNTRUSTED));
    const link = path.join(scratch, 'link.yml');
    fs.symlinkSync(nassajDshLayerPath(), link);
    assert.throws(() => verifyNassajDshLayer(link), codeOf(DSH_LAUNCH_ERROR.LAYER_UNTRUSTED));
    assert.throws(() => verifyNassajDshLayer(path.join(scratch, 'absent.yml')), codeOf(DSH_LAUNCH_ERROR.LAYER_UNTRUSTED));
  });

  it('removes both user layers a turn could write (file or planted directory)', () => {
    const dshHome = path.join(scratch, 'reset', '.dsh');
    const profileLayer = path.join(dshHome, 'profiles', 'nassaj-acp', 'cordis.patch.yml');
    fs.mkdirSync(path.dirname(profileLayer), { recursive: true });
    fs.writeFileSync(profileLayer, 'hostile');
    fs.mkdirSync(path.join(dshHome, 'cordis.patch.yml', 'nested'), { recursive: true });
    resetDshUserLayers(dshHome);
    assert.equal(fs.existsSync(profileLayer), false);
    assert.equal(fs.existsSync(path.join(dshHome, 'cordis.patch.yml')), false);
    resetDshUserLayers(path.join(scratch, 'never-created')); // absent layers are fine
  });
});

describe('the node that runs dsh', () => {
  it(`accepts node >= ${DSH_MIN_NODE_VERSION} only`, () => {
    for (const ok of ['24.9.0', 'v24.9.0', '24.18.1', '25.0.0', '30.1.2']) assert.equal(isSupportedNodeVersion(ok), true, ok);
    for (const bad of ['24.8.9', '22.20.0', 'v18.0.0', '24', 'abc', '']) assert.equal(isSupportedNodeVersion(bad), false, bad);
  });

  it('is the server\'s own absolute node; a relative, missing or too-old runtime is refused', () => {
    assert.equal(resolveDshNode(), process.execPath);
    const refused = codeOf(DSH_LAUNCH_ERROR.NODE_UNSUPPORTED);
    assert.throws(() => resolveDshNode({ execPath: 'node', version: '24.18.1' }), refused);
    assert.throws(() => resolveDshNode({ execPath: path.join(scratch, 'no-node'), version: '24.18.1' }), refused);
    assert.throws(() => resolveDshNode({ execPath: process.execPath, version: '22.11.0' }), refused);
  });

  it('runs only a Node script: a .js/.mjs file or a node shebang', () => {
    const write = (name: string, body: string) => { const f = path.join(scratch, name); fs.writeFileSync(f, body); return f; };
    assert.ok(assertNodeScript(write('cli.mjs', 'export {};\n')));
    assert.ok(assertNodeScript(write('dsh', '#!/usr/bin/env node\nimport("x");\n')));
    const link = path.join(scratch, 'dsh-link');
    fs.symlinkSync(path.join(scratch, 'cli.mjs'), link);
    assert.ok(assertNodeScript(link));
    const refused = codeOf(DSH_LAUNCH_ERROR.BINARY_NOT_NODE);
    assert.throws(() => assertNodeScript(write('sh-wrapper', '#!/bin/sh\nexec claude "$@"\n')), refused);
    assert.throws(() => assertNodeScript(write('native', '\u007fELF\u0002\u0001')), refused);
    assert.throws(() => assertNodeScript(path.join(scratch, 'missing')), refused);
  });
});

describe('the member\'s dsh directories', () => {
  it('a planted symlink is unlinked and replaced by a real directory; its target is untouched', () => {
    const target = path.join(scratch, 'operator-agents');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'skill.md'), 'operator');
    const dir = path.join(scratch, 'member', '.agents');
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.symlinkSync(target, dir);
    ensureRealDirectory(dir);
    assert.equal(fs.lstatSync(dir).isDirectory(), true);
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(fs.readFileSync(path.join(target, 'skill.md'), 'utf8'), 'operator');
  });

  it('a regular file where a directory belongs is refused', () => {
    const file = path.join(scratch, 'member', '.tmp');
    fs.writeFileSync(file, 'x');
    assert.throws(() => ensureRealDirectory(file), codeOf(DSH_LAUNCH_ERROR.HOME_NOT_DIRECTORY));
  });
});
