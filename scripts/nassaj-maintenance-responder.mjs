#!/usr/bin/env node
/** Dependency-free loopback responder used while the public origin is fenced. */
import http from 'node:http';
import { fileURLToPath } from 'node:url';

export const MAINTENANCE_PORT = 3311;
export const MAINTENANCE_RETRY_AFTER = 30;
export const MAINTENANCE_NONCE = 'nassaj-maintenance-v1';
export const MAINTENANCE_BODY = `${JSON.stringify({
    schema: 'nassaj-maintenance/v1', state: 'maintenance', nonce: MAINTENANCE_NONCE,
})}\n`;

/** Return the exact, immutable maintenance response for every HTTP request. */
export function respondMaintenance(_request, response) {
    response.writeHead(503, {
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(MAINTENANCE_BODY),
        'Content-Type': 'application/json; charset=utf-8',
        'Retry-After': String(MAINTENANCE_RETRY_AFTER),
        'X-Content-Type-Options': 'nosniff',
        'X-Nassaj-Maintenance-Nonce': MAINTENANCE_NONCE,
    });
    response.end(MAINTENANCE_BODY);
}

/** Create the fixed loopback-only server. No caller-controlled bind input exists. */
export function createMaintenanceResponder() {
    const server = http.createServer(respondMaintenance);
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 1_000;
    server.requestTimeout = 5_000;
    server.maxRequestsPerSocket = 16;
    return server;
}

async function main() {
    if (process.argv.length !== 2) throw new Error('maintenance_responder_accepts_no_arguments');
    const server = createMaintenanceResponder();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(MAINTENANCE_PORT, '127.0.0.1', resolve);
    });
    const shutdown = () => server.close(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((error) => {
        process.stderr.write(`Nassaj maintenance responder failed (${error.message}).\n`);
        process.exitCode = 78;
    });
}
