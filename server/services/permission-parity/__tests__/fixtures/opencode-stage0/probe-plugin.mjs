// ADR-226 stage 0 probe plugin (recording only, never shipped). Loaded by opencode 1.19.5 from
// OPENCODE_CONFIG_CONTENT `plugin: ["file://…/probe-plugin.mjs"]`. Every observation is appended
// to $PROBE_LOG (a /var/tmp scratch file). Behaviour per call is driven by markers in the
// tool args, so the fake LLM script decides it:
//   PROBE_THROW   -> throw in tool.execute.before (does the body stop?)
//   PROBE_SLOW    -> await $PROBE_SLOW_MS (default 65000) before allowing (does a long hook abort?)
//   PROBE_FREEZE  -> deep-freeze output.args and lock output.args (does a later plugin's mutation
//                    take effect, and does the built-in body still run on frozen args?)
//   PROBE_MUTATE  -> set output.args.description = 'mutated-by-probe' (is stdout state.input pre/post hook?)
// At load: fstat fd 3, open it as a duplex, send hello{nonce}, await the reply ($PROBE_HELLO_WAIT_MS).
// Only the plugin function is exported: opencode loads every export as a plugin.
import fs from 'node:fs';
import net from 'node:net';

const LOG = process.env.PROBE_LOG;
const log = (row) => { if (LOG) fs.appendFileSync(LOG, `${JSON.stringify({ t: Date.now(), pid: process.pid, ...row })}\n`); };
const has = (args, marker) => JSON.stringify(args ?? {}).includes(marker);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function fd3Stat() {
  try {
    const s = fs.fstatSync(3);
    return { open: true, socket: s.isSocket(), fifo: s.isFIFO(), file: s.isFile() };
  } catch (error) {
    return { open: false, error: String(error?.code ?? error) };
  }
}

/** Bun 1.4.4 (opencode 1.19.5): `new net.Socket({ fd: 3 })` closes at once; record that. */
function netSocketCtorWorks() {
  try {
    const s = new net.Socket({ fd: 3, readable: true, writable: true });
    const ok = !s.destroyed;
    return { ok, destroyed: s.destroyed };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** hello over fd 3 opened with net.connect({ fd: 3 }); resolves with the reply line or an error tag. */
function helloOverSocket(nonce, waitMs) {
  return new Promise((resolve) => {
    let socket;
    try {
      socket = net.connect({ fd: 3 });
    } catch (error) {
      resolve({ ok: false, method: 'net.connect', error: String(error) });
      return;
    }
    let buf = '';
    const timer = setTimeout(() => resolve({ ok: false, method: 'net.connect', error: 'timeout' }), waitMs);
    socket.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i >= 0) { clearTimeout(timer); resolve({ ok: true, method: 'net.connect', reply: JSON.parse(buf.slice(0, i)), socket }); }
    });
    socket.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, method: 'net.connect', error: String(error) }); });
    socket.write(`${JSON.stringify({ type: 'hello', nonce, pid: process.pid, t: Date.now() })}\n`);
  });
}

export const NassajStage0Probe = async (ctx) => {
  const t0 = Date.now();
  const stat = fd3Stat();
  log({ ev: 'load', fd3: stat, directory: ctx?.directory, ctxKeys: Object.keys(ctx ?? {}).sort(),
    stdinIsTTY: Boolean(process.stdin.isTTY), argv: process.argv.slice(1) });
  let channel = null;
  if (stat.open && process.env.PROBE_CTOR === '1') log({ ev: 'net-socket-ctor', ...netSocketCtorWorks() });
  if (stat.open && process.env.PROBE_HELLO !== '0') {
    const res = await helloOverSocket(process.env.PROBE_NONCE ?? '', Number(process.env.PROBE_HELLO_WAIT_MS ?? 30000));
    channel = res.socket ?? null;
    log({ ev: 'hello-result', ok: res.ok, method: res.method, reply: res.reply, error: res.error, waitedMs: Date.now() - t0 });
  }
  return {
    'tool.execute.before': async (input, output) => {
      log({ ev: 'before', tool: input?.tool, sessionID: input?.sessionID, callID: input?.callID,
        inputKeys: Object.keys(input ?? {}).sort(), outputKeys: Object.keys(output ?? {}).sort(),
        args: JSON.parse(JSON.stringify(output?.args ?? null)) });
      if (channel) channel.write(`${JSON.stringify({ type: 'pre', tool: input?.tool, callID: input?.callID })}\n`);
      if (has(output?.args, 'PROBE_THROW')) throw new Error('nassaj:probe_denied: stage-0 probe refused this call');
      if (has(output?.args, 'PROBE_SLOW')) {
        await new Promise((r) => setTimeout(r, Number(process.env.PROBE_SLOW_MS ?? 65000)));
        log({ ev: 'slow-done', callID: input?.callID });
      }
      if (has(output?.args, 'PROBE_MUTATE') && output?.args && typeof output.args === 'object') {
        output.args.description = 'mutated-by-probe';
      }
      if (has(output?.args, 'PROBE_FREEZE')) {
        deepFreeze(output.args);
        try {
          Object.defineProperty(output, 'args', { value: output.args, writable: false, configurable: false });
          log({ ev: 'frozen', callID: input?.callID, locked: true });
        } catch (error) {
          log({ ev: 'frozen', callID: input?.callID, locked: false, error: String(error) });
        }
      }
    },
    'tool.execute.after': async (input, output) => {
      log({ ev: 'after', tool: input?.tool, sessionID: input?.sessionID, callID: input?.callID,
        inputKeys: Object.keys(input ?? {}).sort(), outputKeys: Object.keys(output ?? {}).sort(),
        outputType: typeof output?.output, title: output?.title });
      // Never on the K1 shim check, whose exact output the fake LLM verifies.
      const shimCheck = input?.args?.command === 'command -v ssh pm2';
      if (typeof output?.output === 'string' && process.env.PROBE_APPEND === '1' && !shimCheck) output.output += '\nPROBE_APPENDED';
    },
    'shell.env': async (input, output) => {
      log({ ev: 'shell.env', inputKeys: Object.keys(input ?? {}).sort(), outputKeys: Object.keys(output ?? {}).sort(),
        envHasSecret: Boolean(output?.env && 'NASSAJ_PROBE_SECRET' in output.env) });
      if (output?.env) {
        output.env.PROBE_SHELL_ENV = 'set-by-probe';
        if (process.env.PROBE_SCRUB === 'delete') delete output.env.NASSAJ_PROBE_SECRET;
        if (process.env.PROBE_SCRUB === 'undefined') output.env.NASSAJ_PROBE_SECRET = undefined;
      }
    },
  };
};
