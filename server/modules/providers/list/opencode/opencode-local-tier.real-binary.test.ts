/**
 * opencode-local-tier.real-binary.test — ADR-LOCAL-INSTR-TIER-001 (S4), C1/C2/I9
 * against the REAL opencode binary and a mock OpenAI-compatible server.
 *
 * Opt-in (spawns a real binary, uses the network only for opencode's own catalog):
 *   NASSAJ_TEST_REAL_OPENCODE_BINARY=$HOME/.opencode/bin/opencode TMPDIR=/var/tmp \
 *     node scripts/run-isolated-node-tests.mjs server <this file>
 *
 * The local config dir is built by the production code (prepareOpenCodeLocalTier)
 * from fixtures in a hermetic HOME. L1 is the real emitter output for a realistic
 * rule set. Asserts:
 *  - C1: a local turn's system prompt carries `tier=local32` and not the full REV;
 *    a GLM turn (ordinary dir) carries the full REV;
 *  - C2: the subagent request reaches the local provider (no `model:` pin);
 *  - the task tool lists exactly the five allowed agents, and survives L1 (I9);
 *  - the researcher subagent works itself: its tools carry no `task` (no re-delegation).
 */
import { sandboxHome, sandboxRoot } from '../../tests/helpers/hermetic-sandbox.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { localFixture, withRev } from '@/shared/tests/instruction-rev-fixture.js';

const BINARY = process.env.NASSAJ_TEST_REAL_OPENCODE_BINARY?.trim() || '';
const skip = !BINARY || !fs.existsSync(BINARY) ? 'set NASSAJ_TEST_REAL_OPENCODE_BINARY to run' : false;

type Captured = { model: string; tools: string[]; system: string; taskDescription: string };
const requests: Captured[] = [];
const SUBAGENT_MARK = 'SUBAGENT-MARK-RESEARCHER';
const LOCAL_TEXT = localFixture('compact local rules (fixture)\nreply in Arabic\n');
const FULL_TEXT = withRev('# full rules (fixture)\n', null);
const FULL_REV = FULL_TEXT.trimEnd().split('\n').pop() as string;
const LOCAL_REV = LOCAL_TEXT.trimEnd().split('\n').pop() as string;

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] };
}
const USAGE = { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };

/** Scripted replies: the coordinator delegates once to researcher, everything else answers. */
function reply(body: Record<string, any>): Array<Record<string, unknown>> {
  const tools: string[] = (body.tools ?? []).map((tool: any) => tool.function?.name);
  const messages: any[] = body.messages ?? [];
  const system = messages.filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const task = (body.tools ?? []).find((tool: any) => tool.function?.name === 'task');
  if (tools.length) requests.push({ model: body.model, tools, system, taskDescription: task?.function?.description ?? '' });
  const text = (t: string) => [chunk({ role: 'assistant', content: t }), { ...chunk({}, 'stop'), ...USAGE }];
  if (!tools.length || system.includes(SUBAGENT_MARK)) return text('done');
  if (tools.includes('task') && messages[messages.length - 1]?.role === 'user') {
    const call = { index: 0, id: 'call_1', type: 'function', function: {
      name: 'task', arguments: JSON.stringify({ description: 'probe', prompt: 'research', subagent_type: 'researcher' }),
    } };
    return [chunk({ role: 'assistant', tool_calls: [call] }), { ...chunk({}, 'tool_calls'), ...USAGE }];
  }
  return text('ok');
}

let server: http.Server;
let baseUrl = '';

function runOpenCode(
  env: Record<string, string>, model: string, extraArgs: string[] = [],
): Promise<{ code: number | null; stderr: string }> {
  const work = fs.mkdtempSync(path.join(sandboxRoot, 'work-'));
  const state = fs.mkdtempSync(path.join(sandboxRoot, 'xdg-'));
  return new Promise((resolve) => {
    const child = spawn(BINARY, ['run', '--format', 'json', '--model', model, ...extraArgs, '--', 'go'], {
      cwd: work,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin', HOME: sandboxHome, TMPDIR: process.env.TMPDIR || '/var/tmp',
        XDG_DATA_HOME: path.join(state, 'data'), XDG_CACHE_HOME: path.join(state, 'cache'),
        XDG_STATE_HOME: path.join(state, 'state'), OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1', ...env,
      },
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: stderr.slice(-2000) }); });
  });
}

describe('local tier against the real opencode binary', { skip }, () => {
  let userId = 0;
  let localModel = '';
  let l1 = '';

  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      req.on('end', () => {
        if (req.url?.endsWith('/models')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const part of reply(JSON.parse(raw || '{}'))) res.write(`data: ${JSON.stringify(part)}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

    const claude = path.join(sandboxHome, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, 'AGENTS.local.md'), LOCAL_TEXT);
    fs.writeFileSync(path.join(claude, 'AGENTS.md'), FULL_TEXT);
    const agents = path.join(sandboxHome, '.claude', 'opencode', 'agent');
    fs.mkdirSync(agents, { recursive: true });
    for (const agent of ['researcher', 'backend-dev', 'devops', 'scribe', 'qa-critic', 'architect', 'tester']) {
      const mark = agent === 'researcher' ? `${SUBAGENT_MARK}\n` : '';
      const permission = agent === 'researcher' ? 'permission:\n  task: deny\n' : '';
      fs.writeFileSync(path.join(agents, `${agent}.md`),
        `---\ndescription: "${agent} card"\nmode: subagent\nmodel: opencode/removed-free\n${permission}---\n${mark}You are ${agent}.\n`);
    }

    const db = await import('@/modules/database/index.js');
    await db.initializeDatabase();
    db.appConfigDb.set('local_models.enabled', 'true');
    db.appConfigDb.set('local_models.consent_version', '1');
    userId = db.userDb.createUser('local-tier-real', 'hash', 'user').id;
    const { localModelsService } = await import('@/modules/providers/services/local-models.service.js');
    const saved = localModelsService.save(userId, {
      name: 'mock', baseUrl, runtime: 'llamacpp', models: [{ id: 'm1', contextWindow: 32768 }],
    });
    localModel = `${(saved as { providerId: string }).providerId}/m1`;

    const { emitOpenCodeRules } = await import('@/services/isolation/opencode-rule-emitter.js');
    l1 = JSON.stringify(emitOpenCodeRules({
      plan: false,
      rules: [
        { tool: 'bash', kind: 'bash', match: 'prefix', pattern: 'pm2 restart', effect: 'deny' },
        { tool: 'bash', kind: 'bash', match: 'glob', pattern: 'rm -rf *', effect: 'ask' },
      ],
    }).l1);
  });

  after(() => new Promise<void>((resolve) => { server?.close(() => resolve()); }));

  it('local turn: slim REV, five agents under L1, subagent on the local provider, no re-delegation', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    requests.length = 0;
    const run = await runOpenCode({ XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: l1 }, localModel);
    assert.equal(run.code, 0, run.stderr);

    const coordinator = requests.filter((r) => !r.system.includes(SUBAGENT_MARK));
    const subagent = requests.filter((r) => r.system.includes(SUBAGENT_MARK));
    assert.ok(coordinator.length >= 1, 'the coordinator reached the mock');
    for (const r of coordinator) {
      assert.ok(r.system.includes(LOCAL_REV), 'C1: slim REV line in the system prompt');
      assert.ok(r.system.includes('tier=local32'));
      assert.ok(!r.system.includes(FULL_REV), 'not the full REV');
    }
    const listed = [...coordinator[0].taskDescription.matchAll(/^- ([\w-]+):/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(listed, ['backend-dev', 'devops', 'qa-critic', 'researcher', 'scribe'], 'I9: allow-list holds under L1');

    assert.equal(subagent.length >= 1, true, 'C2: the researcher request reached the local provider');
    assert.equal(subagent[0].model, 'm1');
    assert.ok(!subagent[0].tools.includes('task'), 'the researcher does the work itself');
  });

  it('bypass turn (--dangerously-skip-permissions): the five-agent list still holds', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    requests.length = 0;
    const run = await runOpenCode(
      { XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: l1 }, localModel, ['--dangerously-skip-permissions'],
    );
    assert.equal(run.code, 0, run.stderr);
    const coordinator = requests.find((r) => !r.system.includes(SUBAGENT_MARK) && r.taskDescription);
    assert.ok(coordinator, 'the coordinator reached the mock with a task tool');
    const listed = [...coordinator.taskDescription.matchAll(/^- ([\w-]+):/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(listed, ['backend-dev', 'devops', 'qa-critic', 'researcher', 'scribe']);
  });

  it('GLM turn: the ordinary dir carries the full REV', async () => {
    const { ensureOpenCodeGovernance, resolveOpenCodeConfigHomeForUser } = await import('./opencode-governance.js');
    const { materializeOpenCodeConfig } = await import('@/services/isolation/opencode-config-material.js');
    const dir = resolveOpenCodeConfigHomeForUser(userId);
    ensureOpenCodeGovernance(userId, dir);
    assert.equal(materializeOpenCodeConfig(dir, { callerId: userId }), true);
    requests.length = 0;
    // The glm block's host is fixed to api.z.ai; only this test points it at the mock.
    const inline = JSON.stringify({ provider: { glm: { options: { baseURL: baseUrl, apiKey: 'test' } } } });
    const run = await runOpenCode({
      XDG_CONFIG_HOME: path.dirname(dir), OPENCODE_PERMISSION: l1, OPENCODE_CONFIG_CONTENT: inline,
    }, 'glm/glm-5.2');
    assert.equal(run.code, 0, run.stderr);
    assert.ok(requests.length >= 1, 'the GLM turn reached the mock');
    assert.ok(requests[0].system.includes(FULL_REV), 'full REV line');
    assert.ok(!requests[0].system.includes('tier=local32'));
  });
});
