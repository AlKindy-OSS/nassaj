import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

test('ADR-187 internal chat has no model, transcript, or shared websocket dependency', () => {
  const root = path.dirname(new URL(import.meta.url).pathname);
  const source = fs.readdirSync(root).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');
  for (const forbidden of ['ChatIncomingMessage', 'WebSocketWriter', 'message_coordination_ingress', 'turn-supervisor', 'providers/', 'transcript']) {
    assert.equal(source.includes(forbidden), false, `forbidden dependency: ${forbidden}`);
  }
});
