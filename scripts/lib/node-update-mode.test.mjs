import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { resolveNodeUpdateMode, assertLegacyNodePublication } from './node-update-mode.mjs';

test('trusted mode precedence rejects empty, duplicate, malformed and symlink configuration', t => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'update-mode-'));
    t.after(() => fs.rmSync(root, {recursive:true, force:true}));
    const file=path.join(root,'.env');
    assert.equal(resolveNodeUpdateMode(root, {}),'release');
    for (const content of ['NASSAJ_UPDATE_MODE=', 'NASSAJ_UPDATE_MODE=release\nNASSAJ_UPDATE_MODE=local-main', 'NASSAJ_UPDATE_MODE local-main']) {
        fs.writeFileSync(file,content);
        assert.throws(()=>resolveNodeUpdateMode(root,{}),/invalid_mode|duplicate_mode/);
    }
    fs.writeFileSync(file, 'export NASSAJ_UPDATE_MODE="local-main"');
    assert.equal(resolveNodeUpdateMode(root,{}),'local-main');
    assert.throws(()=>assertLegacyNodePublication(root,{}),/button_required/);
    assert.equal(resolveNodeUpdateMode(root,{NASSAJ_UPDATE_MODE:'release'}),'release');
    assert.throws(()=>resolveNodeUpdateMode(root,{NASSAJ_UPDATE_MODE:''}),/invalid_mode/);
    fs.renameSync(file,path.join(root,'target'));fs.symlinkSync('target',file);
    assert.throws(()=>resolveNodeUpdateMode(root,{}),/ELOOP/);
});
