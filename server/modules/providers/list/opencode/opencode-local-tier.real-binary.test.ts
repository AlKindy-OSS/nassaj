/**
 * opencode-local-tier.real-binary.test — ADR-LOCAL-INSTR-TIER-001 (S4), C1/C2/I9
 * against the REAL opencode binary and a mock OpenAI-compatible server.
 *
 * Opt-in (spawns a real binary; hermetic: two mock servers and a catalog file via
 * OPENCODE_MODELS_PATH, so no network is used):
 *   NASSAJ_TEST_REAL_OPENCODE_BINARY=$HOME/.opencode/bin/opencode TMPDIR=/var/tmp \
 *     node scripts/run-isolated-node-tests.mjs server <this file>
 *
 * The local config dir is built by the production code (prepareOpenCodeLocalTier)
 * from fixtures in a hermetic HOME. L1 is the real emitter output for a realistic
 * rule set. Asserts:
 *  - C1: a local turn's system prompt carries `tier=local32` and not the full REV;
 *    a GLM turn (ordinary dir) carries the full REV;
 *  - owner decision 2026-11-13 (LOCAL_CLOUD_SUBAGENTS): the researcher subagent keeps its
 *    card's cloud pin and its request reaches the `opencode` (Zen) provider endpoint, not
 *    the local one; the other four subagents and the coordinator stay on the local
 *    provider (no `model:` pin, C2). The test catalog points the opencode provider's
 *    `api` at a second mock (test-only; production uses the real catalog's endpoint);
 *  - fail closed: when the researcher's cloud model is absent from the catalog, its
 *    endpoint is unreachable, or it answers 401, the handoff fails visibly (a task tool
 *    error) and no researcher request reaches the local endpoint; a researcher card with
 *    two `model:` lines refuses the turn before any spawn (qa round 1);
 *  - qa round 1: a researcher read of a workspace `.env`, and a researcher `grep "API_KEY"`
 *    (grep denied outright, coordinator decision), are refused and the secret never
 *    reaches the cloud mock;
 *  - a dead HTTPS_PROXY/HTTP_PROXY (NO_PROXY for the loopback mocks) keeps every prompt
 *    off the real Zen even if opencode stopped honouring OPENCODE_MODELS_PATH;
 *  - the task tool lists exactly the five allowed agents, and survives L1 (I9);
 *  - the researcher subagent works itself: its tools carry no `task` (no re-delegation);
 *  - owner decision 2026-11-13: the local PRIMARY's tool schema has no `webfetch` — with
 *    the default agent, under --dangerously-skip-permissions, with `--agent plan` and
 *    plan's L1 (the production plan path, opencode-cli.js `permissionLaunch.args`), and
 *    with `--agent nassaj` (a primary card that itself allows webfetch) — while the
 *    researcher subagent keeps it and a GLM turn still has it;
 *  - qa round 1 probe F: a local file block WITHOUT a leading "*" lets explore/general
 *    back even with the L1 append, i.e. the file's leading "*" is the essential anchor.
 *
 * RELEASE GATE: run this file against the opencode binary being shipped before any
 * release that touches local-tier permissions (opencode-local-tier*.{js,ts},
 * opencode-config-material.js permission blocks, the L1 emitter or its local append,
 * the generated agent cards) or that changes the bundled opencode version. The unit and
 * launcher tests cannot see opencode's merge order; only this file can (see
 * docs/RELEASING.md, Steps → Gates).
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

type Endpoint = 'local' | 'cloud';
type Captured = {
  endpoint: Endpoint; model: string; tools: string[]; system: string; taskDescription: string; toolResults: string[];
};
const requests: Captured[] = [];
const MARK_PREFIX = 'SUBAGENT-MARK-';
const SUBAGENT_MARK = `${MARK_PREFIX}RESEARCHER`;
const markOf = (agent: string) => `${MARK_PREFIX}${agent.toUpperCase()}`;
/** The researcher's cloud pin in the fixture card (as in nassaj-core's generated card). */
const CLOUD_MODEL_ID = 'deepseek-v4.1-flash-free';
const OTHER_LOCAL_AGENTS = ['backend-dev', 'devops', 'scribe', 'qa-critic'];
/** The subagent the scripted coordinator hands work to. */
let delegateTo = 'researcher';
/** When set, the researcher's first step makes this tool call instead of answering. */
let researcherCall: { name: string; args: Record<string, unknown> } | null = null;
/** How the cloud mock answers chat requests. */
let cloudMode: 'ok' | '401' = 'ok';
/** Every raw request body the cloud mock received. */
const cloudBodies: string[] = [];
const ENV_SECRET = 'ENV-SECRET-VALUE-7d1c';
const LOCAL_TEXT = localFixture('compact local rules (fixture)\nreply in Arabic\n');
const FULL_TEXT = withRev('# full rules (fixture)\n', null);
const FULL_REV = FULL_TEXT.trimEnd().split('\n').pop() as string;
const LOCAL_REV = LOCAL_TEXT.trimEnd().split('\n').pop() as string;

function chunk(delta: Record<string, unknown>, finish: string | null = null) {
  return { id: 'c', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] };
}
const USAGE = { usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };

/** Scripted replies: the coordinator delegates once to `delegateTo`, everything else answers. */
function reply(body: Record<string, any>, endpoint: Endpoint): Array<Record<string, unknown>> {
  const tools: string[] = (body.tools ?? []).map((tool: any) => tool.function?.name);
  const messages: any[] = body.messages ?? [];
  const system = messages.filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const task = (body.tools ?? []).find((tool: any) => tool.function?.name === 'task');
  const toolResults = messages.filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)));
  if (tools.length) {
    requests.push({ endpoint, model: body.model, tools, system, taskDescription: task?.function?.description ?? '', toolResults });
  }
  const text = (t: string) => [chunk({ role: 'assistant', content: t }), { ...chunk({}, 'stop'), ...USAGE }];
  if (researcherCall && system.includes(SUBAGENT_MARK) && !toolResults.length) {
    const call = { index: 0, id: 'call_probe', type: 'function', function: {
      name: researcherCall.name, arguments: JSON.stringify(researcherCall.args),
    } };
    return [chunk({ role: 'assistant', tool_calls: [call] }), { ...chunk({}, 'tool_calls'), ...USAGE }];
  }
  if (!tools.length || system.includes(MARK_PREFIX)) return text('done');
  if (tools.includes('task') && messages[messages.length - 1]?.role === 'user') {
    const call = { index: 0, id: 'call_1', type: 'function', function: {
      name: 'task', arguments: JSON.stringify({ description: 'probe', prompt: 'research', subagent_type: delegateTo }),
    } };
    return [chunk({ role: 'assistant', tool_calls: [call] }), { ...chunk({}, 'tool_calls'), ...USAGE }];
  }
  return text('ok');
}

let server: http.Server;
let cloudServer: http.Server;
let baseUrl = '';
let cloudBaseUrl = '';
let catalogPath = '';
let catalogWithoutCloudModel = '';

/** A mock OpenAI-compatible server labelled `endpoint`. */
function mockServer(endpoint: Endpoint): http.Server {
  return http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'm1' }] }));
        return;
      }
      if (endpoint === 'cloud') cloudBodies.push(raw);
      if (endpoint === 'cloud' && cloudMode === '401') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'invalid api key', type: 'authentication_error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const part of reply(JSON.parse(raw || '{}'), endpoint)) res.write(`data: ${JSON.stringify(part)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
}

async function listen(target: http.Server): Promise<string> {
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(target.address() as AddressInfo).port}/v1`;
}

/**
 * A models.dev-shaped catalog with the built-in `opencode` (Zen) provider only. Its `api`
 * is the cloud mock — the one test-only redirection; nothing in the generated config
 * changes. A cost-0 model is what opencode serves without a key (`apiKey: "public"`).
 */
function writeCatalog(file: string, withCloudModel: boolean, api = cloudBaseUrl): string {
  const model = {
    id: CLOUD_MODEL_ID, name: 'DeepSeek V4.1 Flash Free', attachment: false, reasoning: false,
    temperature: true, tool_call: true, release_date: '2026-09-10', last_updated: '2026-09-10',
    modalities: { input: ['text'], output: ['text'] }, open_weights: true,
    limit: { context: 200000, output: 32000 }, cost: { input: 0, output: 0, cache_read: 0 },
  };
  const catalog = { opencode: {
    id: 'opencode', name: 'OpenCode Zen', env: ['OPENCODE_API_KEY'], npm: '@ai-sdk/openai-compatible',
    api, doc: 'https://opencode.ai/docs/zen', models: withCloudModel ? { [CLOUD_MODEL_ID]: model } : {},
  } };
  fs.writeFileSync(file, JSON.stringify(catalog));
  return file;
}

function runOpenCode(
  env: Record<string, string>, model: string, extraArgs: string[] = [], setup?: (work: string) => void,
): Promise<{ code: number | null; stderr: string }> {
  const work = fs.mkdtempSync(path.join(sandboxRoot, 'work-'));
  setup?.(work);
  const state = fs.mkdtempSync(path.join(sandboxRoot, 'xdg-'));
  return new Promise((resolve) => {
    const child = spawn(BINARY, ['run', '--format', 'json', '--model', model, ...extraArgs, '--', 'go'], {
      cwd: work,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        PATH: '/usr/bin:/bin', HOME: sandboxHome, TMPDIR: process.env.TMPDIR || '/var/tmp',
        XDG_DATA_HOME: path.join(state, 'data'), XDG_CACHE_HOME: path.join(state, 'cache'),
        XDG_STATE_HOME: path.join(state, 'state'), OPENCODE_DISABLE_PROJECT_CONFIG: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_MODELS_PATH: catalogPath, OPENCODE_DISABLE_MODELS_FETCH: '1',
        // A dead proxy for anything that is not a loopback mock: no prompt can reach the real Zen.
        HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9',
        https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', ...env,
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
  let localL1 = '';

  before(async () => {
    server = mockServer('local');
    cloudServer = mockServer('cloud');
    baseUrl = await listen(server);
    cloudBaseUrl = await listen(cloudServer);
    catalogPath = writeCatalog(path.join(sandboxRoot, 'models-catalog.json'), true);
    catalogWithoutCloudModel = writeCatalog(path.join(sandboxRoot, 'models-catalog-empty.json'), false);

    const claude = path.join(sandboxHome, '.claude');
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, 'AGENTS.local.md'), LOCAL_TEXT);
    fs.writeFileSync(path.join(claude, 'AGENTS.md'), FULL_TEXT);
    const agents = path.join(sandboxHome, '.claude', 'opencode', 'agent');
    fs.mkdirSync(agents, { recursive: true });
    // Worst case for the primary: a coordinator card that itself grants webfetch.
    fs.writeFileSync(path.join(agents, 'nassaj.md'),
      '---\ndescription: "nassaj coordinator"\nmode: primary\nmodel: opencode/removed-free\npermission:\n  webfetch: allow\n---\nYou are nassaj.\n');
    for (const agent of ['researcher', 'backend-dev', 'devops', 'scribe', 'qa-critic', 'architect', 'tester']) {
      const permission = agent === 'researcher' ? 'permission:\n  task: deny\n' : '';
      // Only the researcher's pin survives generation (LOCAL_CLOUD_SUBAGENTS); the others'
      // pins name a model absent from the catalog, so a kept pin would fail loudly.
      const model = agent === 'researcher' ? `opencode/${CLOUD_MODEL_ID}` : 'opencode/removed-free';
      fs.writeFileSync(path.join(agents, `${agent}.md`),
        `---\ndescription: "${agent} card"\nmode: subagent\nmodel: ${model}\n${permission}---\n${markOf(agent)}\nYou are ${agent}.\n`);
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
    // emitOpenCodeRules returns the L1 object itself (a `.l1` read here once made the
    // env value undefined, so L1 never reached the child).
    l1 = JSON.stringify(emitOpenCodeRules({
      plan: false,
      rules: [
        { tool: 'bash', kind: 'bash', match: 'prefix', pattern: 'pm2 restart', effect: 'deny' },
        { tool: 'bash', kind: 'bash', match: 'glob', pattern: 'rm -rf *', effect: 'ask' },
      ],
    }));
    assert.match(l1, /"\*":"allow"/u, 'L1 is the real emitter output');
    // A local-tier turn's L1, exactly as the launcher builds it.
    const { localTierL1 } = await import('@/services/isolation/opencode-local-tier-material.js');
    localL1 = localTierL1(l1);
  });

  after(async () => {
    await new Promise<void>((resolve) => { server?.close(() => resolve()); });
    await new Promise<void>((resolve) => { cloudServer?.close(() => resolve()); });
  });

  it('local turn: slim REV, five agents under L1, researcher on the cloud provider, no re-delegation', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    requests.length = 0;
    const run = await runOpenCode({ XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localL1 }, localModel);
    assert.equal(run.code, 0, run.stderr);

    const coordinator = requests.filter((r) => !r.system.includes(SUBAGENT_MARK));
    const subagent = requests.filter((r) => r.system.includes(SUBAGENT_MARK));
    assert.ok(coordinator.length >= 1, 'the coordinator reached the mock');
    for (const r of coordinator) {
      assert.equal(r.endpoint, 'local', 'the coordinator stays on the local provider');
      assert.equal(r.model, 'm1');
      assert.ok(r.system.includes(LOCAL_REV), 'C1: slim REV line in the system prompt');
      assert.ok(r.system.includes('tier=local32'));
      assert.ok(!r.system.includes(FULL_REV), 'not the full REV');
    }
    const listed = [...coordinator[0].taskDescription.matchAll(/^- ([\w-]+):/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(listed, ['backend-dev', 'devops', 'qa-critic', 'researcher', 'scribe'], 'I9: allow-list holds under L1');

    assert.equal(subagent.length >= 1, true, 'the researcher request was sent');
    for (const r of subagent) {
      assert.equal(r.endpoint, 'cloud', 'owner 2026-11-13: the researcher runs on the opencode (cloud) provider');
      assert.equal(r.model, CLOUD_MODEL_ID);
    }
    assert.ok(!subagent[0].tools.includes('task'), 'the researcher does the work itself');

    for (const r of coordinator) assert.ok(!r.tools.includes('webfetch'), `local primary has no webfetch: ${r.tools}`);
    assert.ok(subagent[0].tools.includes('webfetch'), `the researcher keeps webfetch: ${subagent[0].tools}`);
  });

  it('plan turn (--agent plan + plan L1): no webfetch on the primary, five agents, researcher keeps it', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const { emitOpenCodeRules } = await import('@/services/isolation/opencode-rule-emitter.js');
    const { localTierL1 } = await import('@/services/isolation/opencode-local-tier-material.js');
    const planL1 = localTierL1(JSON.stringify(emitOpenCodeRules({
      plan: true, rules: [{ tool: 'bash', kind: 'bash', match: 'prefix', pattern: 'pm2 restart', effect: 'deny' }],
    })));
    const prepared = prepareOpenCodeLocalTier(userId);
    requests.length = 0;
    const run = await runOpenCode(
      { XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: planL1 }, localModel, ['--agent', 'plan'],
    );
    assert.equal(run.code, 0, run.stderr);
    const coordinator = requests.filter((r) => !r.system.includes(SUBAGENT_MARK));
    assert.ok(coordinator.length >= 1, 'the plan primary reached the mock');
    for (const r of coordinator) {
      assert.ok(!r.tools.includes('webfetch'), `plan primary has no webfetch: ${r.tools}`);
      assert.ok(!r.tools.includes('edit'), `plan's L1 reached the child (edit denied): ${r.tools}`);
    }
    const withTask = coordinator.find((r) => r.taskDescription);
    assert.ok(withTask, 'the plan primary has the task tool');
    const listed = [...withTask.taskDescription.matchAll(/^- ([\w-]+):/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(listed, ['backend-dev', 'devops', 'qa-critic', 'researcher', 'scribe']);
    const subagent = requests.find((r) => r.system.includes(SUBAGENT_MARK));
    assert.ok(subagent?.tools.includes('webfetch'), 'plan: the researcher keeps webfetch');
  });

  it('probe F: a file block without a leading "*" re-opens the task list despite the L1 append', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const { localTierPermission } = await import('@/services/isolation/opencode-local-tier-material.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    const file = path.join(prepared.configHome, 'opencode', 'opencode.json');
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.permission = localTierPermission(); // the pre-anchor shape: {task, webfetch}, no "*"
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, JSON.stringify(config));
    try {
      requests.length = 0;
      const run = await runOpenCode({ XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localL1 }, localModel);
      assert.equal(run.code, 0, run.stderr);
      const coordinator = requests.find((r) => !r.system.includes(SUBAGENT_MARK) && r.taskDescription);
      assert.ok(coordinator, 'the coordinator reached the mock with a task tool');
      const listed = [...coordinator.taskDescription.matchAll(/^- ([\w-]+):/gmu)].map((m) => m[1]);
      assert.ok(listed.includes('explore') && listed.includes('general'),
        `without the file's leading "*" the built-ins come back: ${listed}`);
    } finally {
      prepareOpenCodeLocalTier(userId); // rewrites the drifted file
    }
    const restored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(restored.permission), ['*', 'task', 'webfetch']);
  });

  it('bypass turn (--dangerously-skip-permissions): the five-agent list still holds', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    requests.length = 0;
    const run = await runOpenCode(
      { XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localL1 }, localModel, ['--dangerously-skip-permissions'],
    );
    assert.equal(run.code, 0, run.stderr);
    const coordinator = requests.find((r) => !r.system.includes(SUBAGENT_MARK) && r.taskDescription);
    assert.ok(coordinator, 'the coordinator reached the mock with a task tool');
    const listed = [...coordinator.taskDescription.matchAll(/^- ([\w-]+):/gmu)].map((m) => m[1]).sort();
    assert.deepEqual(listed, ['backend-dev', 'devops', 'qa-critic', 'researcher', 'scribe']);
    for (const r of requests.filter((x) => !x.system.includes(SUBAGENT_MARK))) {
      assert.ok(!r.tools.includes('webfetch'), `bypass: local primary has no webfetch: ${r.tools}`);
    }
    const subagent = requests.find((r) => r.system.includes(SUBAGENT_MARK));
    assert.ok(subagent?.tools.includes('webfetch'), 'bypass: the researcher keeps webfetch');
  });

  it('--agent nassaj on a local turn: the primary still has no webfetch', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    for (const extra of [['--agent', 'nassaj'], ['--agent', 'nassaj', '--dangerously-skip-permissions']]) {
      requests.length = 0;
      const run = await runOpenCode({ XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localL1 }, localModel, extra);
      assert.equal(run.code, 0, run.stderr);
      const coordinator = requests.filter((r) => !r.system.includes(SUBAGENT_MARK));
      assert.ok(coordinator.length >= 1, 'the primary reached the mock');
      for (const r of coordinator) assert.ok(!r.tools.includes('webfetch'), `${extra}: no webfetch: ${r.tools}`);
      // The shared nassaj card is not generated into the local dir, so opencode falls back
      // to its default primary instead of loading a card that could re-grant webfetch.
      assert.ok(!coordinator.some((r) => r.system.includes('You are nassaj.')), 'the nassaj card is not loaded');
    }
  });

  it("a Claude WebFetch deny in the turn's L1 also removes webfetch from the researcher", async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const { emitOpenCodeRules } = await import('@/services/isolation/opencode-rule-emitter.js');
    const { localTierL1, withLocalTierClaudeDenies } = await import('@/services/isolation/opencode-local-tier-material.js');
    const claudeL1 = JSON.stringify(emitOpenCodeRules({
      plan: false, rules: [{ tool: 'webfetch', kind: 'tool', match: null, pattern: null, effect: 'deny' }],
    }));
    const prepared = prepareOpenCodeLocalTier(userId);
    const env = withLocalTierClaudeDenies(
      { XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localTierL1(claudeL1) }, claudeL1,
    ) as Record<string, string>;
    requests.length = 0;
    const run = await runOpenCode(env, localModel);
    assert.equal(run.code, 0, run.stderr);
    const subagent = requests.find((r) => r.system.includes(SUBAGENT_MARK));
    assert.ok(subagent, 'the researcher ran');
    assert.ok(!subagent.tools.includes('webfetch'), `Claude's deny holds for the researcher: ${subagent.tools}`);
  });

  it('the other four subagents run on the local provider (no cloud pin)', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    try {
      for (const agent of OTHER_LOCAL_AGENTS) {
        delegateTo = agent;
        requests.length = 0;
        const run = await runOpenCode({ XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localL1 }, localModel);
        assert.equal(run.code, 0, run.stderr);
        const subagent = requests.filter((r) => r.system.includes(markOf(agent)));
        assert.ok(subagent.length >= 1, `${agent} ran`);
        for (const r of subagent) {
          assert.equal(r.endpoint, 'local', `${agent} stays on the local provider`);
          assert.equal(r.model, 'm1');
        }
        assert.deepEqual(requests.filter((r) => r.endpoint === 'cloud'), [], `${agent}: nothing reached the cloud`);
      }
    } finally {
      delegateTo = 'researcher';
    }
  });

  it('fail closed: an unresolvable researcher model fails the handoff, never the local model', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    requests.length = 0;
    const run = await runOpenCode({
      XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localL1, OPENCODE_MODELS_PATH: catalogWithoutCloudModel,
    }, localModel);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(requests.filter((r) => r.system.includes(SUBAGENT_MARK)), [],
      'no researcher request reached either endpoint');
    assert.deepEqual(requests.filter((r) => r.endpoint === 'cloud'), []);
    const followUp = requests.find((r) => r.toolResults.length > 0);
    assert.ok(followUp, 'the coordinator got the task result back');
    // Measured on opencode 1.19.5: "Model not found: opencode/deepseek-v4.1-flash-free."
    assert.ok(followUp.toolResults.some((t) => t.includes(`Model not found: opencode/${CLOUD_MODEL_ID}`)),
      `the handoff failed visibly: ${followUp.toolResults}`);
  });

  /** Runs a local turn whose researcher handoff is expected to fail; returns the task result text. */
  async function failedHandoff(env: Record<string, string> = {}): Promise<string> {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    requests.length = 0;
    const run = await runOpenCode({ XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localL1, ...env }, localModel);
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(requests.filter((r) => r.endpoint === 'local' && r.system.includes(SUBAGENT_MARK)), [],
      'never a researcher request on the local model');
    const followUp = requests.find((r) => r.endpoint === 'local' && r.toolResults.length > 0);
    assert.ok(followUp, 'the coordinator got the task result back');
    return followUp.toolResults.join('\n');
  }

  it('fail closed: an unreachable researcher endpoint fails the handoff visibly', async () => {
    const closed = http.createServer();
    const deadUrl = await listen(closed);
    await new Promise<void>((resolve) => { closed.close(() => resolve()); });
    const catalog = writeCatalog(path.join(sandboxRoot, 'models-catalog-dead.json'), true, deadUrl);
    const result = await failedHandoff({ OPENCODE_MODELS_PATH: catalog });
    // Measured on opencode 1.19.5: "Subagent failed (…): Cannot connect to API: ECONNREFUSED: …"
    assert.match(result, /Subagent failed .*Cannot connect to API/u, `visible failure: ${result}`);
  });

  it('fail closed: a 401 from the researcher endpoint fails the handoff visibly', async () => {
    cloudMode = '401';
    try {
      cloudBodies.length = 0;
      const result = await failedHandoff();
      assert.ok(cloudBodies.length >= 1, 'the researcher request went to the cloud endpoint');
      assert.match(result, /Subagent failed .*invalid api key/u, `visible failure: ${result}`);
    } finally {
      cloudMode = 'ok';
    }
  });

  it('qa round 1: a researcher card with two model lines refuses the turn before any spawn', async () => {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const card = path.join(sandboxHome, '.claude', 'opencode', 'agent', 'researcher.md');
    const original = fs.readFileSync(card, 'utf8');
    fs.writeFileSync(card, original.replace(/^model: .*$/mu, (line) => `${line}\nmodel: ${localModel}`));
    try {
      assert.throws(() => prepareOpenCodeLocalTier(userId), (error: any) =>
        error.code === 'local_agent_cards_unavailable' && /fix the researcher model pin/u.test(error.reason));
    } finally {
      fs.writeFileSync(card, original);
    }
    prepareOpenCodeLocalTier(userId);
  });

  /** A local turn whose researcher first makes `call(work)` in a workspace holding a `.env`. */
  async function researcherProbe(call: (work: string) => { name: string; args: Record<string, unknown> }) {
    const { prepareOpenCodeLocalTier } = await import('./opencode-local-tier.js');
    const prepared = prepareOpenCodeLocalTier(userId);
    requests.length = 0;
    cloudBodies.length = 0;
    try {
      const run = await runOpenCode({ XDG_CONFIG_HOME: prepared.configHome, OPENCODE_PERMISSION: localL1 }, localModel, [],
        (work) => {
          fs.writeFileSync(path.join(work, '.env'), `API_KEY=${ENV_SECRET}\n`);
          researcherCall = call(work);
        });
      assert.equal(run.code, 0, run.stderr);
    } finally {
      researcherCall = null;
    }
    const researcher = requests.filter((r) => r.system.includes(SUBAGENT_MARK));
    assert.ok(researcher.every((r) => r.endpoint === 'cloud'), 'the researcher ran on the cloud mock');
    const afterCall = researcher.find((r) => r.toolResults.length > 0);
    assert.ok(afterCall, `the researcher got its tool result back: ${researcher.length} request(s)`);
    assert.ok(cloudBodies.length >= 2, 'the cloud mock saw the researcher before and after the call');
    assert.ok(!cloudBodies.some((body) => body.includes(ENV_SECRET)), 'the .env value never reached the cloud');
    return afterCall.toolResults.join('\n');
  }

  it('qa round 1: a researcher read of the workspace .env is denied and never reaches the cloud', async () => {
    const result = await researcherProbe((work) => ({ name: 'read', args: { filePath: path.join(work, '.env') } }));
    // Measured on opencode 1.19.5 (and the same read succeeds without the card's denies).
    assert.match(result, /prevents you from using this specific tool call/u, `read refused: ${result}`);
  });

  it('coordinator decision: a researcher grep "API_KEY" is refused and never reaches the cloud', async () => {
    // Without the whole-tool deny this returned "Line 1: API_KEY=<value>" (measured, 1.19.5).
    const result = await researcherProbe((work) => ({ name: 'grep', args: { pattern: 'API_KEY', path: work } }));
    // A whole-tool deny drops grep from the researcher's tools (measured, 1.19.5), so the
    // call comes back as an unavailable tool.
    assert.match(result, /unavailable tool 'grep'/u, `grep refused: ${result}`);
    const researcher = requests.filter((r) => r.system.includes(SUBAGENT_MARK));
    for (const r of researcher) assert.ok(!r.tools.includes('grep'), `no grep tool: ${r.tools}`);
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
    assert.ok(requests[0].tools.includes('webfetch'), `a GLM turn keeps webfetch: ${requests[0].tools}`);
  });
});
