// Builds the probe ACP plan. Usage: node make-plan.mjs <workspace> <out.json> <variant>
import fs from 'node:fs';
const [workspace, out, variant = 'main'] = process.argv.slice(2);
const sub = 'SUB' + '\\u005f' + 'STEPS'; // decoded to SUB_STEPS only by dsh's JSON.parse of the tool args
const subSteps = JSON.stringify([{ name: 'bash', raw: JSON.stringify({ command: 'echo from-subagent; ls -l /proc/self/fd', description: 'sub probe' }) }, { text: 'sub done' }]);
const subPrompt = `${sub} ${subSteps} END_SUB`;
const subRaw = `{"description":"probe sub","prompt":${JSON.stringify(subPrompt).replace('\\\\u005f', '\\u005f')}}`;
const fdCmd = 'echo SHELL_FDS; ls -l /proc/$$/fd; echo PPID=$PPID; cat /proc/self/cgroup; env | sort';
const variants = {
  main: [
    { name: 'bash', raw: JSON.stringify({ command: fdCmd, description: 'fd probe' }) },
    { name: 'no_such_tool', raw: '{"x":1}' },
    { name: 'subagent', raw: subRaw },
    { name: 'bash', raw: '[1,2]' },
    { text: 'probe done' },
  ],
  ptrace: [
    { name: 'bash', raw: JSON.stringify({ command: `python3 -I ${process.env.PROBE_DIR}/grab.py $PPID; ps -o pid,ppid,comm -p $PPID`, description: 'ptrace probe' }) },
    { text: 'after ptrace' },
  ],
  ptraceEsc: [
    { name: 'bash', raw: JSON.stringify({ command: `grep -E "NoNewPrivs|Seccomp:" /proc/self/status; python3 -I ${process.env.PROBE_DIR}/grab.py $PPID; ls -l /proc/$$/fd`, description: 'ptrace probe esc', sandbox_permissions: 'danger-full-access', justification: 'probe' }) },
    { name: 'bash', raw: JSON.stringify({ command: 'grep -E "NoNewPrivs|Seccomp:" /proc/self/status', description: 'status' }) },
    { text: 'after ptrace' },
  ],
  paths: [
    { name: 'write', raw: JSON.stringify({ file_path: '~/t2089-tilde.txt', content: 'tilde' }) },
    { name: 'write', raw: JSON.stringify({ file_path: 'notes/rel.txt', content: 'rel' }) },
    { name: 'write', raw: JSON.stringify({ file_path: '$HOME/t2089-var.txt', content: 'var' }) },
    { name: 'bash', raw: JSON.stringify({ command: 'find ~ . -name "t2089-*" -o -name rel.txt | sort', description: 'where' }) },
    { text: 'paths done' },
  ],
  string: [
    { name: 'bash', raw: '"just a string"' },
    { text: 'after string' },
  ],
  malformed: [
    { name: 'bash', raw: '{"command": "echo malformed", "description": "m"' },
    { text: 'after malformed' },
  ],
  cancel: [
    { name: 'bash', raw: JSON.stringify({ command: 'sleep 20; echo late > cancel-witness', description: 'slow' }) },
    { text: 'after cancel' },
  ],
};
const steps = variants[variant];
const plan = [
  { method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'nassaj', version: '0' } } },
  { method: 'session/new', params: { cwd: workspace, mcpServers: [] } },
  { permission: 'allow-once' }, { permission: 'allow-once' }, { permission: 'allow-once' },
  { method: 'session/prompt', params: { sessionId: '$SESSION', prompt: [{ type: 'text', text: `probe NASSAJ_STEPS ${JSON.stringify(steps)} END_STEPS` }] }, timeoutMs: 90000 },
  { wait: 500 },
];
if (variant === 'cancel') {
  const i = plan.findIndex((x) => x.method === 'session/prompt');
  plan[i].noWait = true;
  plan.splice(i + 1, 0, { wait: 2500 }, { notify: 'session/cancel', params: { sessionId: '$SESSION' } }, { wait: 3000 });
}
fs.writeFileSync(out, JSON.stringify(plan, null, 1));
