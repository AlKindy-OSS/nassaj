// B-1228: the public page publisher bounds stored revisions and bytes per site.
// A publish over a cap is refused and the live revision keeps serving; only
// `prune` deletes, and never the live revision.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { run } from './public-page-publish.mjs';

const base = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'public-page-caps-'));
test.after(() => rmSync(base, { recursive: true, force: true }));

let sequence = 0;
/** A fresh content root plus a page source directory writer. */
function workspace() {
    const dir = path.join(base, `case-${sequence += 1}`);
    mkdirSync(dir);
    const root = path.join(dir, 'root');
    const source = path.join(dir, 'source');
    const write = (text) => {
        mkdirSync(source, { recursive: true });
        writeFileSync(path.join(source, 'index.html'), `<!doctype html><title>t</title><p>${text}</p>`);
    };
    const cli = (...args) => run([...args, '--root', root]);
    const publishPage = async (text) => { write(text); return cli('publish', '--site', 'demo', '--dir', source); };
    const pointer = () => JSON.parse(readFileSync(path.join(root, 'pointers', 'demo.json'), 'utf8')).revision;
    const revisions = () => readdirSync(path.join(root, 'bundles', 'demo')).filter((n) => /^[a-f0-9]{64}$/.test(n));
    return { root, cli, publishPage, pointer, revisions };
}

/** Run `fn` with temporary cap overrides. */
async function withCaps(caps, fn) {
    const saved = Object.fromEntries(Object.keys(caps).map((key) => [key, process.env[key]]));
    Object.assign(process.env, caps);
    try { return await fn(); } finally {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    }
}

test('a publish over the revision cap is refused and the live revision is unchanged', async () => {
    const w = workspace();
    await withCaps({ NASSAJ_PUBLIC_SITE_MAX_REVISIONS: '2' }, async () => {
        await w.publishPage('one');
        const second = await w.publishPage('two');
        await assert.rejects(w.publishPage('three'), /already stores 2 revisions \(cap 2\).*live revision is unchanged/);
        assert.equal(w.pointer(), second.revision);
        assert.equal(w.revisions().length, 2);
        const again = await w.publishPage('two');
        assert.equal(again.action, 'republished', 'identical content reuses its revision under the cap');
    });
});

test('a publish over the byte cap is refused before anything is staged', async () => {
    const w = workspace();
    const first = await w.publishPage('small');
    await withCaps({ NASSAJ_PUBLIC_SITE_MAX_BYTES: '400' }, async () => {
        await assert.rejects(w.publishPage('x'.repeat(500)), /would store \d+ bytes \(cap 400\)/);
    });
    assert.equal(w.pointer(), first.revision);
    assert.deepEqual(w.revisions(), [first.revision]);
    assert.deepEqual(readdirSync(path.join(w.root, 'bundles', 'demo')).filter((n) => n.startsWith('staging-')), []);
});

test('prune keeps the newest revisions and always the live one, even when it is the oldest', async () => {
    const w = workspace();
    const published = [];
    for (const [index, text] of ['a', 'b', 'c', 'd'].entries()) {
        const result = await w.publishPage(text);
        published.push(result.revision);
        const stamp = new Date(Date.UTC(2026, 0, 1, 0, index));
        utimesSync(path.join(w.root, 'bundles', 'demo', result.revision), stamp, stamp);
    }
    await w.cli('rollback', '--site', 'demo', '--to', published[0]);
    const result = await w.cli('prune', '--site', 'demo', '--keep', '1');
    assert.equal(result.live, published[0]);
    assert.deepEqual(result.removed.sort(), [published[1], published[2]].sort());
    assert.deepEqual(w.revisions().sort(), [published[0], published[3]].sort());
    assert.equal(w.pointer(), published[0], 'prune never moves the pointer');
    await assert.rejects(w.cli('prune', '--site', 'demo', '--keep', '0'), /--keep must be a positive integer/);
});

test('a malformed cap override is refused rather than ignored', async () => {
    const w = workspace();
    await withCaps({ NASSAJ_PUBLIC_SITE_MAX_REVISIONS: 'lots' }, async () => {
        await assert.rejects(w.publishPage('one'), /NASSAJ_PUBLIC_SITE_MAX_REVISIONS must be a positive integer/);
    });
});
