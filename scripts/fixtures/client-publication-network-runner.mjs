/** Test-only loopback server; refuse to start unless isolated from the invoking network namespace. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const [root, launcher, hostNetwork] = process.argv.slice(2);
const network = fs.readlinkSync('/proc/self/ns/net');
assert.notEqual(network, hostNetwork, 'test must never serve or fetch through the host network');
const requests = [];
const server = createServer((request, response) => {
    requests.push(request.url);
    const name = request.url === '/' ? 'index.html' : request.url === '/version.json' ? 'version.json' : null;
    if (!name) { response.writeHead(404).end(); return; }
    response.setHeader('Cache-Control', 'no-store');
    response.end(fs.readFileSync(path.join(root, 'dist', name)));
});
let child, timer;
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3004, '127.0.0.1', resolve); });
    child = spawn(process.execPath, [launcher], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stderr = '', stdout = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    timer = setTimeout(() => child.kill('SIGTERM'), 8000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    process.stdout.write(JSON.stringify({ code, stderr, stdout, requests, network }));
} finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise(resolve => child.once('exit', resolve));
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
