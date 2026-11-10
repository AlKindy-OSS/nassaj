// T-2089 S0: builds stage0-evidence.json from probe run dirs (scrubbed: paths, pids, inodes, ids).
// Usage: node build-evidence.cjs <out.json>  (run ids below are the 2026-11-07 recording).
const fs = require('fs');
// Recorded 2026-11-07 on this host; requires the run dirs to still exist.
const runs = { main_scope: 'nkrSa7', main_direct_noXdg: '0HAkPz', malformed_json: 'THbsvu', string_args: 'VSsQeH', cancel: 'L1jHA2',
  ptrace_sandboxed_scope: 'AIznad', ptrace_sandboxed_direct: '14YxzG', ptrace_escalated_scope: '7hDlTB', ptrace_escalated_direct: 'DQTdQb', first_rel: '6QLIZ3' };
const scrub = (s) => s.replace(/:(\d{6,8})([,}\]])/g, (_m, _n, e) => `:"<PID>"${e}`).replace(/\/var\/tmp\/t2089-run-[A-Za-z0-9]+/g, '<RUN>').replace(/\/var\/tmp\/t2089-probe-scripts/g, '<PROBE>').replace(/\/home\/nassaj\/[^ "]*\/fixtures\/stage0/g, '<PROBE>')
  .replace(/socket:\[\d+\]/g, 'socket:[N]').replace(/pipe:\[\d+\]/g, 'pipe:[N]').replace(/\/proc\/\d+/g, '/proc/<PID>')
  .replace(/PPID=\d+/g, 'PPID=<DSH_PID>').replace(/\b\d{6,8}\b/g, '<PID>').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<UUID>')
  .replace(/dsh-subprocess-<PID>-[0-9a-f]+\.scope/g, 'dsh-subprocess-<PID>-<HEX>.scope').replace(/Nov  7 \d\d:\d\d/g, '<DATE>').replace(/"t":\d+/g, '"t":0');
const out = { provenance: { task: 'T-2089 S0 (ADR-225)', package: '@deepseek-ai/dsh@0.2.2-rc.1', node: process.version, recordedAt: '2026-11-07',
  launch: 'node <dsh>/lib/bin.js nassaj-acp --from-default-profile acp --patch <RUN>/layers/probe-layer.yml',
  layer: 'server/governance/dsh-nassaj-layer.yml with llm-deepseek baseURL -> 127.0.0.1 fake LLM (probe only) + insert {id: nassaj-parity-probe, name: <rel|abs|file-url>}',
  stdio: "recorder spawns dsh with ['pipe','pipe','pipe','pipe'(fd3),'ignore','ignore','ignore','pipe'(fd7)]",
  host: { 'kernel.yama.ptrace_scope': fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim(), bwrap: 'absent' } }, runs: {} };
for (const [label, id] of Object.entries(runs)) {
  const R = `/var/tmp/t2089-run-${id}`;
  const read = (f) => { try { return fs.readFileSync(`${R}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(scrub(l))); } catch { return []; } };
  const acp = read('out/traffic.jsonl').filter((o) => { const u = o.msg?.params?.update; return (u && !['usage_update', 'agent_message_chunk'].includes(u.sessionUpdate)) || o.msg?.error || o.msg?.result?.stopReason || o.msg?.method === 'session/request_permission'; }).map((o) => o.msg);
  const plugin = read('layers/plugin/probe.log').map((o) => { if (o.kind === 'apply') { delete o.fds; } if (o.agent) o.agent = { id: o.agent.id }; delete o.keys; return o; });
  out.runs[label] = { acp, plugin, proc: read('out/traffic.jsonl.proc').map((p) => ({ label: p.label, listening: p.listening, lsofInet: p.lsofInet, fd3: p.fds.find((f) => f.startsWith('3->')), fd7: p.fds.find((f) => f.startsWith('7->')) })),
    llmRequests: read('out/llm.jsonl').length };
}
const tools = fs.readFileSync('/var/tmp/t2089-run-nkrSa7/out/llm.jsonl', 'utf8').trim().split('\n').map(JSON.parse).find((x) => x.body?.tools);
out.liveTools = tools.body.tools.map((t) => t.name);
out.findings = {
  a_plugin_from_layer: 'loads; a ./relative name resolves against the --patch layer file location; absolute path and file:// URL also load',
  b_single_file_plugin: "node: imports + ctx only (inject ['tools']) registers pre-execute/execute/post-execute prepend+global and tools/result global; sees subagent calls (exec.agent.id = subagent id, rootCallId = its own callId, no parent token)",
  b_subagent_calls_not_on_acp: 'subagent tool calls reach the plugin but emit NO ACP tool_call/tool_call_update; the subagent tool returns immediately (started subagent <id>)',
  b_prepend_not_outermost: 'tool-jobs registers a prepend pre-execute listener AFTER the plugin and runs before it; spill-policy likewise on post-execute',
  c_inventory: 'ctx.events._hooks[event] (private) lists {ctx, callback, prepend, global}; owner = hook.ctx.fiber.entry.options.id/name',
  d_no_listener: 'ss -ltunp shows no listening socket for the dsh pid at session/new and after prompt; lsof -i only an outbound connection to the LLM origin',
  e_fd_inheritance: 'bash children hold only fds 0,1,2 on BOTH paths (systemd-run --user --scope when XDG_RUNTIME_DIR is set; direct spawn under the Nassaj exact env, cgroup = pm2 service); sandboxed children get EPERM on pidfd_getfd and /proc/<dsh>/mem; an APPROVED escalation (sandbox_permissions danger-full-access) child takes fd 3 and fd 7 via pidfd_getfd and reads /proc/<dsh>/mem (host ptrace_scope=0)',
  f_non_ready: 'malformed JSON args and non-object args (array, string) fail the WHOLE turn in the DeepSeek Messages decoder (JSON-RPC -32603) before any tool_call or pipeline event; unknown tool DOES reach pre-execute and execute and fails in the body; cancel during the body: pre-execute and execute ran, post-execute isError "tool call aborted", the command did not finish',
  f_raw_arguments: 'no raw argument text on either side: the plugin sees deep-frozen parsed exec.arguments, ACP sees parsed rawInput; JSON.stringify of both is identical for every root call in the recording',
  tool_args_validated_in_body: 'schema validation (e.g. bash missing description) runs inside the body after pre-execute and execute listeners',
  tool_env: 'bash tool env has no DEEPSEEK_API_KEY (dsh strips it)',
};
fs.writeFileSync(process.argv[2], `${JSON.stringify(out, null, 1)}\n`);
