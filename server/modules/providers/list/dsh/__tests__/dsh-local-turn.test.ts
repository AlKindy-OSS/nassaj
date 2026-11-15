/**
 * ADR-227 "DSH local corrector" / T-2108 qa condition 4 — the corrector of a local
 * turn never outlives a refusal: when the layer cannot be written, or the DSH_PATH
 * semantic check refuses the composed profile, the corrector is closed and the run
 * directory removed before the error surfaces; a successful open is undone by close().
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { openDshLocalCorrector } from '@/services/isolation/dsh-local-corrector.js';

import { nassajDshPolicyPluginPath, readVerifiedNassajDshLayer } from '../dsh-launch.js';
import { openDshLocalTurn } from '../dsh-local-turn.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 't2108-turn-'));
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const launch = {
  command: process.execPath, script: path.join(sandbox, 'bin.js'), home: path.join(sandbox, 'home'),
  layerText: readVerifiedNassajDshLayer().text, pluginEntry: path.join(nassajDshPolicyPluginPath(), 'index.mjs'),
};
const resolved = { local: { connectOrigin: 'http://127.0.0.1:9', model: 'qwen3:30b', contextWindow: 32768, outputTokens: 4096 }, secret: 'k' };

/** The real corrector, with its port and close calls recorded. */
function spyCorrector() {
  const seen: { port: number; closed: number } = { port: 0, closed: 0 };
  const open = async (input: Parameters<typeof openDshLocalCorrector>[0]) => {
    const corrector = await openDshLocalCorrector(input);
    seen.port = corrector.port;
    return { ...corrector, close: async () => { seen.closed += 1; await corrector.close(); } };
  };
  return { seen, open };
}
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

describe('openDshLocalTurn refusal paths (T-2108)', () => {
  it('a layer that cannot be written closes the corrector', async () => {
    const blocker = path.join(sandbox, 'not-a-dir');
    fs.writeFileSync(blocker, 'x');
    const { seen, open } = spyCorrector();
    await assert.rejects(openDshLocalTurn({ launch, resolved, runId: 'r1' }, { runsRoot: blocker, openCorrector: open, serverEnv: {} }));
    assert.equal(seen.closed, 1);
    assert.equal(await portOpen(seen.port), false);
  });

  it('a DSH_PATH override whose profile fails the local check closes the corrector and removes the layer', async () => {
    const failing = path.join(sandbox, 'failing-dsh.mjs');
    fs.writeFileSync(failing, 'process.exit(3);\n');
    const runsRoot = path.join(sandbox, 'runs-2');
    const { seen, open } = spyCorrector();
    await assert.rejects(openDshLocalTurn({ launch: { ...launch, script: failing }, resolved, runId: 'r2' },
      { runsRoot, openCorrector: open, serverEnv: { DSH_PATH: failing } }), (error: Error & { code?: string }) => error.code === 'dsh_override_unverified');
    assert.equal(seen.closed, 1);
    assert.deepEqual(fs.readdirSync(runsRoot), []);
  });

  it('a successful open is fully undone by close()', async () => {
    const runsRoot = path.join(sandbox, 'runs-3');
    const { seen, open } = spyCorrector();
    const opened = await openDshLocalTurn({ launch, resolved, runId: 'r3' }, { runsRoot, openCorrector: open, serverEnv: {} });
    assert.ok(fs.existsSync(opened.launch.layerPath));
    assert.equal(opened.launch.env.NASSAJ_DSH_LOCAL_TOKEN, opened.token);
    assert.equal(opened.launch.args.at(-1), opened.launch.layerPath);
    await opened.close();
    await opened.close();
    assert.equal(seen.closed, 1);
    assert.equal(await portOpen(seen.port), false);
    assert.deepEqual(fs.readdirSync(runsRoot), []);
  });
});
