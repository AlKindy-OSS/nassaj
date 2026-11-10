/**
 * dsh-policy-plugin.test — T-2089 S4 (ADR-225) units of the Nassaj dsh policy plugin's
 * pure parts and of the broker's handshake / result rules.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as broker from '@/services/permission-parity/dsh-parity-broker.js';
import { DSH_REVIEWED_TOOLS } from '@/services/permission-parity/dsh-claude-tools.js';
import { loadDshToolMap } from '@/services/permission-parity/dsh-tool-map.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginUrl = pathToFileURL(path.resolve(here, '..', '..', '..', 'governance', 'dsh-policy-plugin', 'index.mjs')).href;
const recorded = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'dsh-policy-tools.json'), 'utf8'));

describe('T-2089/T-2091 dsh policy plugin', async () => {
  const plugin = await import(pluginUrl);

  it('canonical JSON: sorted keys, no spaces; non-pure JSON is null; plugin and broker agree', () => {
    const samples: unknown[] = [{ b: 1, a: [true, null, 'x', { d: 2.5, c: -1 }] }, 'ünï', 0, [], {}];
    for (const value of samples) assert.equal(plugin.canonicalJson(value), broker.canonicalJson(value));
    assert.equal(plugin.canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    for (const bad of [Number.NaN, Infinity, undefined, () => 1, new Date(0), new Map(), { a: undefined }, [1n]]) {
      assert.equal(plugin.canonicalJson(bad), null);
      assert.equal(broker.canonicalJson(bad), null);
    }
  });

  it('every live tool schema uses only keywords the validator implements; others are reported', () => {
    for (const tool of recorded.tools) assert.deepEqual(plugin.unsupportedKeywords(tool.input_schema), [], tool.name);
    assert.deepEqual(plugin.unsupportedKeywords({ type: 'object', properties: { a: { type: 'string', pattern: 'x' } } }), ['$.a.pattern']);
    assert.deepEqual(plugin.unsupportedKeywords({ type: 'object', oneOf: [] }), ['$.oneOf']);
    assert.deepEqual(plugin.unsupportedKeywords({ type: 'date' }), ['$.type=date']);
  });

  it('validates type, required, properties, additionalProperties, enum and items', () => {
    const bashSchema = recorded.tools.find((tool: { name: string }) => tool.name === 'bash').input_schema;
    assert.equal(plugin.schemaError(bashSchema, { command: 'ls', description: 'd' }), null);
    assert.match(plugin.schemaError(bashSchema, { command: 'ls' }), /description: required/);
    assert.match(plugin.schemaError(bashSchema, { command: 7, description: 'd' }), /command: expected string/);
    const schema = { type: 'object', additionalProperties: false, properties: { mode: { type: 'string', enum: ['a'] },
      list: { type: 'array', items: { type: 'integer' } } } };
    assert.match(plugin.schemaError(schema, { extra: 1 }), /extra: not allowed/);
    assert.match(plugin.schemaError(schema, { mode: 'b' }), /not in enum/);
    assert.match(plugin.schemaError(schema, { list: [1, 1.5] }), /list\[1\]: expected integer/);
    assert.equal(plugin.schemaError({ type: 'number' }, 3), null);
  });

  it('dsh bump checklist (qa I6): every reviewed dsh pin was re-verified live with the policy plugin', () => {
    // On a dsh bump this fails until, on the NEW version: dsh-policy-live.test.ts passes
    // (NASSAJ_TEST_DSH_LIVE_BIN=<fresh /var/tmp install>/node_modules/@deepseek-ai/dsh/lib/bin.js), the
    // inventory and tools are re-recorded into fixtures/dsh-policy-tools.json (provenance.package), the
    // reviewed tool map (dsh-tool-map.json, with dsh-claude-tools.js) is re-reviewed, the plugin's
    // engines.dsh range is checked, and the stage-0 fd and T-2091 capability probes are rerun.
    const locks = path.resolve(here, '..', '..', '..', 'harness-locks', 'dsh');
    const reviewed = fs.readdirSync(locks).filter((name) => fs.statSync(path.join(locks, name)).isDirectory()).sort();
    const verified = String(recorded.provenance.package).replace('@deepseek-ai/dsh@', '');
    assert.deepEqual(reviewed, [verified], `dsh pins ${reviewed.join(', ')} vs live-verified ${verified}: run the bump checklist`);
  });

  it('the tool map data file and the adapter code name the same tools with the same Claude mapping', () => {
    const map = loadDshToolMap();
    assert.deepEqual(Object.keys(map.tools).sort(), Object.keys(DSH_REVIEWED_TOOLS).sort());
    for (const [name, entry] of Object.entries(map.tools)) {
      assert.deepEqual([entry.claude, entry.cls], [DSH_REVIEWED_TOOLS[name].claude, DSH_REVIEWED_TOOLS[name].cls], name);
    }
  });

  describe('broker handshake (protocol 2)', () => {
    const probes = { P1: { ok: true }, P2: { ok: true }, P3: { ok: true } };
    const declared = () => recorded.tools.map((tool: { name: string, input_schema: unknown }) => ({ name: tool.name, schema: tool.input_schema, schemaIssues: [] }));
    const hello = (patch: Record<string, unknown> = {}) => ({ type: 'hello', protocol: 2, probes, tools: declared(), ...patch });
    it('accepts passing probes; P1 / P2 failures and a legacy hello refuse', () => {
      assert.equal(broker.helloRefusal(hello()), null);
      assert.equal(broker.helloRefusal(hello({ probes: { ...probes, P1: { ok: false } } })), 'dsh_cap_tools_api');
      assert.equal(broker.helloRefusal(hello({ probes: { ...probes, P2: { ok: false } } })), 'dsh_cap_gate');
      assert.equal(broker.helloRefusal(hello({ probes: { ...probes, P3: { ok: false } } })), null, 'P3 is non-fatal');
      assert.equal(broker.helloRefusal({ type: 'hello', inventory: {} }), 'dsh_cap_channel');
    });
    it('hides new tools, tools with a changed mapped field and tools with unsupported schema keywords', () => {
      const tools = declared().map((tool: Record<string, any>) => (tool.name === 'grep' ? { ...tool, schemaIssues: ['$.x.pattern'] }
        : tool.name === 'write' ? { ...tool, schema: { ...tool.schema, properties: { ...tool.schema.properties, content: { type: 'array' } } } } : tool));
      const { allowedTools, hiddenTools } = broker.helloTools(hello({ tools: [...tools, { name: 'shiny', schema: {}, schemaIssues: [] }] }));
      assert.deepEqual(hiddenTools, ['grep', 'shiny', 'write']);
      assert.ok(allowedTools.includes('bash') && !allowedTools.includes('write'));
    });
  });

  describe('broker results', () => {
    function make(engine: Record<string, unknown>) {
      const kills: number[] = [];
      const incidents: Array<Record<string, unknown>> = [];
      const instance = broker.createParityBroker({ engine: engine as never, kill: () => kills.push(1),
        onIncident: (incident: Record<string, unknown>) => incidents.push(incident), askMember: async () => 'reject' });
      return { instance, kills, incidents };
    }
    const args = { command: 'ls', description: 'd' };
    const allowEngine = (post: Record<string, unknown> = { block: false, additionalContext: [] }) => ({
      decideTool: async () => ({ decision: 'allow', claude: { tool_name: 'Bash', tool_input: args } }),
      hooks: { postToolUse: async (call: Record<string, unknown>) => ({ ...post, seen: call }) } });
    async function decided(engine: Record<string, unknown>) {
      const made = make(engine);
      await made.instance.receive({ id: 1, type: 'hello', protocol: 2, probes: { P1: { ok: true }, P2: { ok: true } },
        tools: recorded.tools.map((tool: { name: string, input_schema: unknown }) => ({ name: tool.name, schema: tool.input_schema, schemaIssues: [] })) });
      await made.instance.receive({ id: 2, type: 'pre', callId: 'c1', tool: 'bash', args, hash: broker.argumentHash(args) });
      return made;
    }
    it('post: PostToolUse hooks run with Claude\'s input; a block is passed back', async () => {
      const { instance, kills } = await decided(allowEngine({ block: true, reason: 'fix it', additionalContext: ['ctx'] }));
      const reply = await instance.receive({ id: 3, type: 'post', callId: 'c1', tool: 'bash', hash: broker.argumentHash(args),
        isError: false, bodyRan: true, output: 'out' });
      assert.deepEqual([reply.block, reply.reason, reply.additionalContext], [true, 'fix it', ['ctx']]);
      assert.equal(kills.length, 0);
    });
    it('post: an undecided result kills unless it failed without its body running', async () => {
      const { instance, kills } = await decided(allowEngine());
      await instance.receive({ id: 3, type: 'post', callId: 'other', tool: 'bash', hash: null, isError: true, bodyRan: false });
      assert.equal(kills.length, 0);
      await instance.receive({ id: 4, type: 'post', callId: 'other2', tool: 'bash', hash: null, isError: true, bodyRan: true });
      assert.equal(kills.length, 1);
    });
    it('a second hello is refused and kills dsh', async () => {
      const made = await decided(allowEngine());
      const reply = await made.instance.receive({ id: 9, type: 'hello', protocol: 2, probes: { P1: { ok: true }, P2: { ok: true } },
        tools: [] });
      assert.equal(reply.ok, false);
      assert.equal(made.kills.length, 1);
    });
    it('a hash that does not match the arguments is denied', async () => {
      const made = await decided(allowEngine());
      const reply = await made.instance.receive({ id: 5, type: 'pre', callId: 'c2', tool: 'bash', args, hash: '0'.repeat(64) });
      assert.equal(reply.decision, 'deny');
    });
  });
});
