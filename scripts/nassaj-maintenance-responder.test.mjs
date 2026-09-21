import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import test from 'node:test';

import {
    MAINTENANCE_BODY, MAINTENANCE_NONCE, MAINTENANCE_PORT, MAINTENANCE_RETRY_AFTER,
} from './nassaj-maintenance-responder.mjs';

const entry = new URL('./nassaj-maintenance-responder.mjs', import.meta.url);

function request() {
    return new Promise((resolve, reject) => {
        const call = http.get({ hostname: '127.0.0.1', port: MAINTENANCE_PORT, path: '/health?ignored=yes', timeout: 2_000 }, (response) => {
            const chunks = []; response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, headers: response.headers,
                body: Buffer.concat(chunks).toString('utf8') }));
        });
        call.once('error', reject); call.once('timeout', () => call.destroy(new Error('readiness_timeout')));
    });
}
async function start() {
    const child = spawn(process.execPath, [entry.pathname], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (child.exitCode !== null) throw new Error(stderr || `responder_exited_${child.exitCode}`);
        try { await request(); return child; } catch { await new Promise((resolve) => setTimeout(resolve, 25)); }
    }
    child.kill('SIGKILL'); throw new Error('responder_not_ready');
}

test('fixed responder returns exact 503 headers and body and accepts no dynamic arguments', async (t) => {
    let child;
    try { child = await start(); } catch (error) {
        if (/EADDRINUSE/.test(error.message)) return t.skip('fixed maintenance port is already occupied');
        throw error;
    }
    t.after(() => child.kill('SIGKILL'));
    const response = await request();
    assert.equal(response.status, 503);
    assert.equal(response.headers['retry-after'], String(MAINTENANCE_RETRY_AFTER));
    assert.equal(response.headers['x-nassaj-maintenance-nonce'], MAINTENANCE_NONCE);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body, MAINTENANCE_BODY);
    const invalid = spawn(process.execPath, [entry.pathname, '--port', '9999'], { stdio: 'ignore' });
    assert.equal(await new Promise((resolve) => invalid.once('exit', resolve)), 78);
});

test('responder is ready after a hard crash and a clean fixed-port restart', async (t) => {
    let first;
    try { first = await start(); } catch (error) {
        if (/EADDRINUSE/.test(error.message)) return t.skip('fixed maintenance port is already occupied');
        throw error;
    }
    first.kill('SIGKILL'); await new Promise((resolve) => first.once('exit', resolve));
    const second = await start(); t.after(() => second.kill('SIGKILL'));
    assert.equal((await request()).body, MAINTENANCE_BODY);
});
