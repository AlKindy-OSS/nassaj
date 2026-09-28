// Preloaded network guard for offline verifier tests: any socket, DNS or fetch
// attempt prints NET_ATTEMPT to stderr and throws. Usage: node --require <this>.
'use strict';
const net = require('node:net');
const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');

/** Records and refuses one network attempt. */
function refuse(what) {
    globalThis.__netAttempts = (globalThis.__netAttempts || 0) + 1;
    process.stderr.write(`NET_ATTEMPT ${what}\n`);
    process.exitCode = 99;
    throw new Error(`network blocked: ${what}`);
}

net.Socket.prototype.connect = function connect() { refuse('net.Socket.connect'); };
net.connect = net.createConnection = () => refuse('net.connect');
tls.connect = () => refuse('tls.connect');
http.request = http.get = () => refuse('http.request');
https.request = https.get = () => refuse('https.request');
for (const k of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny']) {
    dns[k] = () => refuse(`dns.${k}`);
    dns.promises[k] = async () => refuse(`dns.promises.${k}`);
}
globalThis.fetch = async () => refuse('fetch');
