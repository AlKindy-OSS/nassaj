/** Test-only isolated PM2 RPC process. No host PM2/CLI or root journal access. */
import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
const [inputFile] = process.argv.slice(2);
const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const Message = createRequire(import.meta.url)(input.codecEntry);
const peers = new Set(); const children = new Map(); let entries = []; let nextId = 44;
const trace = method => fs.appendFileSync(input.traceFile, `${JSON.stringify({ method, at: Date.now() })}\n`);
function frameLength(bytes) {
    if (!bytes.length) return null;
    if (bytes[0] !== 0x12 || bytes.length > 1024 * 1024) throw Error('fixture RPC frame');
    let at = 1;
    for (let n = 0; n < 2; n++) {
        if (bytes.length < at + 4) return null;
        const size = bytes.readUInt32BE(at); at += 4;
        if (!size || size > 1024 * 1024 - at) throw Error('fixture RPC length');
        at += size; if (bytes.length < at) return null;
    }
    if (bytes.length !== at) throw Error('fixture RPC trailing'); return at;
}
async function start(entry) {
    const env = entry.pm2_env;
    const child = spawn(env.exec_interpreter, [env.pm_exec_path], { cwd: env.pm_cwd,
        env: { ...env.env, PATH: '/usr/bin:/bin', HOME: input.home, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(entry.pm_id, child); await once(child, 'spawn');
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => fs.appendFileSync(input.childOutput, bytes));
    Object.assign(env, env.env, { status: 'online', created_at: Date.now(), pm_uptime: Date.now(),
        axm_actions: [], axm_monitor: {}, axm_options: {}, axm_dynamic: {}, version: input.version });
    entry.pid = child.pid; return entry;
}
async function stop(entry) {
    const child = children.get(entry.pm_id);
    if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; }
    children.delete(entry.pm_id); entry.pid = 0;
    Object.assign(entry.pm2_env, { status: 'stopped', axm_actions: [], axm_monitor: {} });
}
async function dispatch(request) {
    trace(request.method);
    if (request.method === 'getMonitorData') return entries;
    if (request.method === 'prepare') {
        const env = structuredClone(request.args[0]); env.pm_id = nextId++; env.vizion_running = false;
        env.env.unique_id = '12345678-1234-4234-8234-123456789abc';
        const entry = { name: env.name, pm_id: env.pm_id, pid: 0, pm2_env: env }; entries.push(entry);
        return [{ pm2_env: env, process: {} }];
    }
    const id = request.args[0]; const entry = entries.find(value => value.pm_id === id);
    if (!entry) throw Error('fixture unknown slot');
    if (request.method === 'stopProcessId') { await stop(entry); return { pm2_env: entry.pm2_env, process: { pid: 0 } }; }
    if (request.method === 'deleteProcessId') { await stop(entry); entries = entries.filter(value => value !== entry); return []; }
    if (request.method === 'startProcessId') { await start(entry); return { pm2_env: entry.pm2_env, process: { pid: entry.pid } }; }
    throw Error('fixture unapproved method');
}
const old = { name: input.oldDescriptor.name, pm_id: 4, pid: 0,
    pm2_env: { ...input.oldDescriptor, pm_id: 4, vizion_running: false,
        env: { ...input.oldDescriptor.env, unique_id: '87654321-4321-4321-8321-123456789abc' } } };
await start(old); entries.push(old);
const server = net.createServer(socket => {
    peers.add(socket); socket.on('close', () => peers.delete(socket)); socket.on('error', () => {});
    let buffer = Buffer.alloc(0); let handling = false;
    socket.on('data', async bytes => {
        try {
            if (handling) throw Error('fixture overlapping RPC');
            buffer = Buffer.concat([buffer, bytes]); if (!frameLength(buffer)) return;
            handling = true; const [request, id] = new Message(buffer).args; buffer = Buffer.alloc(0);
            const result = await dispatch(request); socket.write(new Message([{ args: [result] }, id]).toBuffer()); handling = false;
        } catch { socket.destroy(); }
    });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
fs.writeFileSync(input.readyFile, JSON.stringify({ old, daemonPid: process.pid, port: server.address().port }));
async function close() {
    for (const peer of peers) peer.destroy();
    for (const entry of entries) await stop(entry);
    await new Promise(resolve => server.close(resolve)); process.exit(0);
}
process.once('SIGTERM', close); process.once('SIGINT', close);
