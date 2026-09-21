#!/usr/bin/env node
/** Inert durable-effect launcher. The governed command cannot start before gate release. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function proc(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
        return { startTicks: fields[19], pgid: Number(fields[2]) };
    } catch { return null; }
}
function bootId() {
    try { return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return null; }
}
function parentAlive(config) {
    const observed = proc(config.parent.pid);
    return bootId() === config.parent.bootId && observed?.startTicks === config.parent.startTicks;
}
function groupMembers(pgid) {
    const members = [];
    for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        if (pid !== process.pid && proc(pid)?.pgid === pgid) members.push(pid);
    }
    return members;
}
function killDescendants() {
    for (const pid of groupMembers(process.pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
    }
}

async function main() {
    let config;
    try { config = JSON.parse(process.argv[2]); } catch { process.exit(125); }
    if (!config || !Array.isArray(config.args) || typeof config.command !== 'string'
        || typeof config.gate !== 'string' || path.resolve(config.gate) !== config.gate
        || !Number.isSafeInteger(config.parent?.pid) || !config.parent.startTicks || !config.parent.bootId) process.exit(125);
    // Inert phase: no command or descendant exists. Parent death before the
    // durable DB+receipt handshake makes this wrapper self-terminate.
    while (!fs.existsSync(config.gate)) {
        if (!parentAlive(config)) process.exit(124);
        await sleep(10);
    }
    if (!parentAlive(config)) process.exit(124);
    try {
        fs.unlinkSync(config.gate);
        const fd = fs.openSync(path.dirname(config.gate), 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch { process.exit(125); }
    const child = spawn(config.command, config.args, { cwd: config.cwd, env: process.env, shell: false, stdio: 'inherit' });
    let parentTimer = setInterval(() => {
        if (parentAlive(config)) return;
        killDescendants();
        clearInterval(parentTimer); parentTimer = null;
        process.exitCode = 124;
    }, 25);
    const result = await new Promise((resolve) => {
        child.once('error', () => resolve({ code: 125, signal: null }));
        child.once('close', (code, signal) => resolve({ code, signal }));
    });
    if (parentTimer) clearInterval(parentTimer);
    // Commands may leave unref'd/background descendants after their leader
    // closes. They remain part of this wrapper's detached PGID and are killed
    // before the wrapper reports completion to the durable worker.
    killDescendants();
    for (let attempt = 0; attempt < 100 && groupMembers(process.pid).length; attempt += 1) await sleep(5);
    if (groupMembers(process.pid).length) process.exit(123);
    if (result.signal) process.kill(process.pid, result.signal);
    process.exit(Number.isInteger(result.code) ? result.code : 125);
}

void main();
