/** Fixture-only IPC barrier: acquire the real permanent mutex before the operator proceeds. */
import fs from 'node:fs';
import { fork, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const file = fileURLToPath(import.meta.url);
const settings = JSON.parse(fs.readFileSync(new URL('./facade-map.json', import.meta.url)));
if (process.argv[2] === '--holder') {
    const fd = fs.openSync(`${settings.control}/first-cutover-state.flock`, 'r+');
    const result = spawnSync('/usr/bin/flock', ['-x', '-w', '5', '-E', '75', '3'], { stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 6000 });
    if (result.status !== 0) process.exit(78);
    const acquired = process.hrtime.bigint(); process.send({ decision: 'held', pid: process.pid });
    process.once('message', message => {
        if (message?.decision !== 'release-after' || message.ms !== 2300) process.exit(78);
        const release = waiter => { fs.closeSync(fd);
            fs.writeFileSync(`${settings.contentionEvidence}.partial`, JSON.stringify({ stage: settings.contentionStage,
                acquiredNs: String(acquired), releasedNs: String(process.hrtime.bigint()),
                heldNs: String(process.hrtime.bigint() - acquired), ...(waiter ? { waiter } : {}) }) + '\n', { mode: 0o600 });
            fs.renameSync(`${settings.contentionEvidence}.partial`, settings.contentionEvidence);
            process.disconnect(); };
        if (!['gate', 'target_verified'].includes(settings.contentionStage)) { setTimeout(() => release(), message.ms); return; }
        // Release only after the selected real helper finishes, irrespective of startup/PM2 delay.
        const deadline = process.hrtime.bigint() + 10_000_000_000n;
        const poll = setInterval(() => {
            const done = `${settings.contentionEvidence}.waiter-done`;
            if (fs.existsSync(done)) { clearInterval(poll); release(JSON.parse(fs.readFileSync(done))); }
            else if (process.hrtime.bigint() >= deadline) { clearInterval(poll); process.exit(78); }
        }, 5);
    });
} else {
    /** Only the selected fixed source boundary is delayed; no production authority or callback changes. */
    globalThis.fixtureContentionBarrier = async stage => {
        if (settings.contentionStage !== stage) return;
        const holder = fork(file, ['--holder'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => { holder.kill('SIGKILL'); reject(Error('fixture_holder_deadline')); }, 7000);
            holder.once('error', reject); holder.once('exit', code => { if (code) reject(Error('fixture_holder_exit')); });
            holder.once('message', message => {
                if (message?.decision !== 'held' || message.pid !== holder.pid) { holder.kill('SIGKILL'); reject(Error('fixture_holder_identity')); return; }
                clearTimeout(timer); globalThis.fixtureContentionWaiter = stage;
                holder.send({ decision: 'release-after', ms: 2300 }); resolve();
            });
        });
    };
}
