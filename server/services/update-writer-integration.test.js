import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { createUpdateMaintenanceGate } from './update-maintenance-gate.js';

const read = (file) => fs.readFileSync(file, 'utf8');

test('source-update writer coverage matrix keeps every required surface leased', () => {
    const index = read('server/index.js');
    const chat = read('server/modules/websocket/services/chat-websocket.service.ts');
    const shell = read('server/modules/websocket/services/shell-websocket.service.ts');
    const standalone = read('server/services/standalone-terminals/standalone-terminal-registry.ts');
    const clientWatcher = read('scripts/client-build-watch.mjs');
    const serverWatcher = read('scripts/server-build-watch.mjs');
    const workflowSupervisor = read('server/modules/workflow-supervisor/supervisor.ts');

    const matrix = [
        ['file-save', index], ['file-create', index], ['file-rename', index],
        ['file-delete', index], ['file-upload', index], ['image-upload', index],
        ['attachment-upload', index], ['git-write', index], ['command-exec', index],
        ['workflow-cycle', workflowSupervisor],
        ['provider-turn', chat], ['provider-side-query', chat],
        ['managed-pty', shell], ['standalone-pty', read('server/routes/terminals.js')],
        ['client-watcher-build', clientWatcher], ['server-watcher-build', serverWatcher],
    ];
    for (const [kind, source] of matrix) {
        assert.match(source, new RegExp(`['"]${kind}['"]`), `${kind} must remain covered`);
    }

    assert.match(shell, /writerLease\.release\(\)[\s\S]*ptySessionsMap\.delete/);
    assert.match(standalone, /child\.onExit[\s\S]*entry\.writerLease\.release\(\)/);
    assert.match(clientWatcher, /child\.once\('exit'[\s\S]*writerLease\.release\(\)/);
    assert.match(serverWatcher, /child\.once\('exit'[\s\S]*writerLease\.release\(\)/);
});

test('legacy managed PTY entries cannot be reattached without a writer lease', () => {
    const shell = read('server/modules/websocket/services/shell-websocket.service.ts');
    assert.match(shell, /if \(existingSession\?\.writerLease\)/);
    assert.match(shell, /if \(existingSession\) \{[\s\S]*existingSession\.pty\.kill\(\)[\s\S]*ptySessionsMap\.delete/);
});

test('finished HTTP response does not release a workflow process lease before exit', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-workflow-lease-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    spawnSync('git', ['init', '-q'], { cwd: root });
    const gate = createUpdateMaintenanceGate({ projectPath: root });
    const processLease = await gate.acquireWriterLease({ kind: 'workflow-cycle', waitMs: 100 });
    const responseFinished = true;
    let updateStarted = false;
    const update = gate.beginUpdate({
        transactionId: 'workflowlease1234', expectedVersion: '1.44.0.0',
        originalHead: '1'.repeat(40), targetCommit: '2'.repeat(40),
    }, { waitMs: 500 }).then((lease) => {
        updateStarted = true;
        return lease;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(responseFinished, true);
    assert.equal(updateStarted, false, 'active workflow still blocks beginUpdate after HTTP completion');
    processLease.release();
    const updateLease = await update;
    assert.equal(updateStarted, true, 'terminal process release admits the updater');
    updateLease.complete();
});
