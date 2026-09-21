import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.js'), 'utf8');

test('CLI has no legacy CloudCLI registry updater or shell-based npm update', () => {
    assert.equal(source.includes('@cloudcli-ai/cloudcli'), false);
    assert.equal(source.includes("execSync('npm"), false);
    assert.match(source, /execFileSync\('npm', \['install', '--global'/);
});

test('source installations route operators to the governed Settings updater', () => {
    assert.match(source, /Source installations are updated through Settings/);
    assert.match(source, /fs\.existsSync\(path\.join\(APP_ROOT, '\.git'\)\)/);
});
