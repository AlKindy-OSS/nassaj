// Turns a raw dsh recording into committed, scrubbed fixtures (T-2086 S1).
// Usage: node scrub.mjs <recDir> <discoveryLlm.jsonl> <outDir> <root>
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [recDir, discoveryLlm, outDir, root] = process.argv.slice(2);
const readJsonl = (file) => fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
const sid = fs.readFileSync(path.join(recDir, 'sid'), 'utf8').trim();

const ids = new Map();
const idFor = (value, prefix) => {
  if (!ids.has(value)) ids.set(value, `<${prefix}_${[...ids.values()].filter((v) => v.startsWith(`<${prefix}_`)).length + 1}>`);
  return ids.get(value);
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
function scrubText(text) {
  return text
    .replaceAll(sid, '<DSH_SESSION_ID>')
    .replaceAll(`${root}/ws`, '<WORKSPACE>')
    .replaceAll(`${root}/outside`, '<OUTSIDE>')
    .replaceAll(`${root}/home`, '<MEMBER_HOME>')
    .replaceAll(root, '<RECORDING_ROOT>')
    .replaceAll('sk-fake-recording-key', '<FAKE_DEEPSEEK_KEY>')
    .replaceAll('http://127.0.0.1:47811', '<FAKE_LLM_ORIGIN>')
    .replaceAll('http://127.0.0.1:47812', '<HOSTILE_ORIGIN>')
    .replaceAll('127.0.0.1:47811', '<FAKE_LLM_HOST>')
    .replace(UUID, (m) => idFor(m, 'UUID'))
    .replace(/msg_fake_\d+/g, (m) => idFor(m, 'MSG'));
}
const scrub = (value) => JSON.parse(scrubText(JSON.stringify(value)));
const sha = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

function summarizeRequest(row) {
  const body = row.body ?? {};
  const { system, tools, ...rest } = body;
  const headers = { ...row.headers };
  for (const name of ['content-length', 'connection']) delete headers[name];
  return {
    endpoint: row.label === 'hostile' ? 'hostile' : 'nassaj-pinned',
    method: row.method,
    url: row.url,
    headers,
    bodyKeys: Object.keys(body),
    body: {
      ...rest,
      systemSha256: system === undefined ? null : sha(system),
      toolNames: Array.isArray(tools) ? tools.map((tool) => tool.name) : [],
    },
  };
}

const run = (file) => readJsonl(path.join(recDir, file)).filter((row) => row.dir !== 'recorder');
const recording = scrub({
  provenance: {
    task: 'T-2086 S1 (ADR-224)',
    package: '@deepseek-ai/dsh@0.2.2-rc.1',
    acpSdk: '@agentclientprotocol/sdk@1.4.0',
    protocolVersion: 1,
    node: process.version,
    recordedAt: '2026-11-07',
    launches: [
      { name: 'first-launch', argv: ['nassaj-acp', '--from-default-profile', 'acp', '--patch', '<NASSAJ_LAYER>'] },
      { name: 'resume-after-refresh', argv: ['--profile', 'nassaj-acp', '--patch', '<NASSAJ_LAYER>'],
        note: 'hostile cordis.patch.yml left in place (no --from-default-profile reset) to prove the layer alone wins' },
    ],
    environment: ['PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=<MEMBER_HOME>', 'LANG', 'TERM', 'TMPDIR=<MEMBER_HOME>/.tmp',
      'DSH_HOME=<MEMBER_HOME>/.dsh', 'DSH_AGENTS_HOME=<MEMBER_HOME>/.agents', 'DEEPSEEK_API_KEY=<FAKE_DEEPSEEK_KEY>',
      'DSH_TELEMETRY_DISABLED=1', 'DEEPSEEK_BASE_URL=<FAKE_LLM_ORIGIN> (recording only)'],
    observations: [
      'dsh advertises sessionCapabilities {close,list,resume} and NO loadSession: history must come from Nassaj.',
      '--from-default-profile resets <DSH_HOME>/profiles/nassaj-acp/cordis.patch.yml to [] on every launch.',
      'Without the Nassaj layer, every /v1/messages body carries dsh_session_log and dsh_plugin_packages '
        + 'even with DSH_TELEMETRY_DISABLED=1 (see withoutNassajLayer).',
      'With the Nassaj --patch layer over a hostile user layer: zero requests reached the hostile origin, '
        + 'no dsh_session_log / dsh_plugin_packages field, telemetry row disabled.',
      'request_permission offers allow-once / reject-once; allow wrote the outside file, reject left it absent.',
      'Inside the bash tool, `command -v claude codex` resolved nothing on PATH=/usr/local/bin:/usr/bin:/bin.',
      'After session/resume in a NEW process, the next /v1/messages carried all prior turns (15 messages).',
      'Each request carries x-deepseek-harness-user-id (anonymous install id) and x-deepseek-harness-session-id.',
    ],
  },
  runs: [
    { name: 'first-launch', traffic: run('traffic1.jsonl') },
    { name: 'resume-after-refresh', traffic: run('traffic2.jsonl') },
  ],
});
const llm = scrub({
  withNassajLayer: readJsonl(path.join(recDir, 'llm.jsonl')).map(summarizeRequest),
  withoutNassajLayer: readJsonl(discoveryLlm).map((row) => ({
    url: row.url, bodyKeys: Object.keys(row.body ?? {}),
  })),
});
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'dsh-acp-recording.json'), `${JSON.stringify(recording, null, 1)}\n`);
fs.writeFileSync(path.join(outDir, 'dsh-llm-requests.json'), `${JSON.stringify(llm, null, 1)}\n`);
