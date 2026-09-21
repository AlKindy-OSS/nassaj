import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

import express from 'express';
import Database from 'better-sqlite3';
import jwt from 'jsonwebtoken';

import { createDocumentSharesStore, migrateDocumentShares } from '../modules/database/document-shares.js';
import { createDocumentShareVerifier } from '../services/document-share-auth.js';
import { inspectSharedDocument, readSharedDocument, readSharedPageAsset, saveSharedDocumentAtomically, isShareableDocument, DOCUMENT_MAX_BYTES } from '../services/document-share-files.js';
import { createSharedDocumentPreviewBuilder } from '../services/document-share-preview.js';

import { createDocumentSharesRouter } from './document-shares.js';

const secret = 'synthetic-test-secret-document-shares-only-123456789';

async function fixture(t, buildPreview) {
  const base = await fs.mkdtemp(path.join(process.cwd(), 'document-sharing-test-'));
  const root = path.join(base, 'project');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'proposal.txt'), 'first version');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE projects (project_id TEXT PRIMARY KEY, project_path TEXT, isArchived INTEGER)');
  db.prepare('INSERT INTO projects VALUES (?,?,0)').run('p1', root);
  migrateDocumentShares(db);
  const store = createDocumentSharesStore(db);
  const users = new Map([
    [1, { id: 1, role: 'owner', status: 'active', password_changed_at: 0 }],
    [2, { id: 2, role: 'user', status: 'active', password_changed_at: 0 }],
    [3, { id: 3, role: 'user', status: 'active', password_changed_at: 0 }],
  ]);
  const members = new Set([2]);
  const audit = [];
  const verifyUser = createDocumentShareVerifier({ getUserById: (id) => users.get(id) }, secret);
  const app = express();
  app.use(express.json());
  app.use('/api', createDocumentSharesRouter({ getStore: () => store, verifyUser,
    isMember: (_root, id) => members.has(id), audit: (...args) => audit.push(args), publicOrigin: 'https://nassaj.example', buildPreview }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    db.close();
    await fs.rm(base, { recursive: true, force: true });
  });
  const authorization = (id) => ({ Authorization: `Bearer ${jwt.sign({ userId: id, pwd_iat: 0 }, secret, { expiresIn: '1h' })}` });
  const request = (url, options = {}) => fetch(origin + url, options);
  const create = async (audience = 'client', extra = {}) => {
    const response = await request('/api/projects/p1/document-shares', { method: 'POST',
      headers: { ...authorization(1), 'Content-Type': 'application/json' },
      body: JSON.stringify({ relativePath: 'docs/proposal.txt', audience, ...extra }) });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  return { base, root, db, store, users, members, audit, verifyUser, request, create, authorization };
}

test('client capability persists, serves latest save, and never exposes secret in list or metadata', async (t) => {
  const f = await fixture(t);
  const created = await f.create();
  const token = new URLSearchParams(created.sharePath.split('#')[1]).get('token');
  const headers = { 'X-Share-Token': token };
  const url = `/api/document-shares/${created.share.id}`;
  const meta = await f.request(url, { headers });
  assert.equal(meta.status, 200);
  assert.equal(meta.headers.get('cache-control'), 'no-store');
  const payload = await meta.json();
  assert.equal(payload.document.name, 'proposal.txt');
  assert.equal(created.shareUrl, `https://nassaj.example${created.sharePath}`);
  assert.ok(!JSON.stringify(payload).includes(f.root));
  assert.ok(!JSON.stringify(f.store.get(created.share.id)).includes(token));
  assert.equal(await (await f.request(`${url}/content`, { headers })).text(), 'first version');
  await saveSharedDocumentAtomically(f.root, 'docs/proposal.txt', 'new complete version');
  assert.equal(await (await f.request(`${url}/content`, { headers })).text(), 'new complete version');
  const list = await (await f.request('/api/projects/p1/document-shares', { headers: f.authorization(1) })).json();
  assert.ok(!JSON.stringify(list).includes('token_hash'));
  assert.ok(!JSON.stringify(f.audit).includes(token));
  migrateDocumentShares(f.db); // A repeated startup must preserve links.
  assert.equal((await f.request(url, { headers })).status, 200);
});

test('HTML preview is isolated, bundles only sibling assets, and content remains an attachment', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'docs', 'landing.assets', 'css'), { recursive: true });
  await fs.mkdir(path.join(f.root, 'docs', 'landing.assets', 'images'), { recursive: true });
  await fs.mkdir(path.join(f.root, 'docs', 'landing.assets', 'fonts'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'docs', 'landing.assets', 'images', 'ok.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await fs.writeFile(path.join(f.root, 'docs', 'landing.assets', 'fonts', 'ui.woff2'), Buffer.from('font'));
  await fs.writeFile(path.join(f.root, 'docs', 'landing.assets', 'css', 'site.css'), '@import "https://bad.example/x.css"; @font-face { font-family:ui; src:url(../fonts/ui.woff2) } .hero { background:url(../images/ok.png) }');
  await fs.writeFile(path.join(f.root, 'docs', 'landing.html'), '<!doctype html><script>window.pwned=1</script><base href="https://bad.example/"><link rel="stylesheet" href="landing.assets/css/site.css"><img src="landing.assets/images/ok.png" onerror="alert(1)"><a href="https://bad.example">go</a><form action="/x"><input></form>');
  const response = await f.request('/api/projects/p1/document-shares', { method: 'POST', headers: { ...f.authorization(1), 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: 'docs/landing.html', audience: 'client' }) });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.share.previewPath, `/api/document-shares/${created.share.id}/preview`);
  assert.equal(created.share.previewScope, 'docs/landing.assets');
  const headers = { 'X-Share-Token': created.sharePath.split('token=')[1] };
  const preview = await f.request(created.share.previewPath, { headers });
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get('content-security-policy'), /^default-src 'none'; script-src 'none'/);
  const body = await preview.json();
  assert.ok(!/script|onerror|<form|<base|bad\.example/i.test(body.html));
  assert.match(body.html, /data:image\/png;base64/i);
  assert.match(body.html, /data:font\/woff2;base64/i);
  assert.ok(body.warnings.includes('STYLE_OMITTED'));
  assert.ok(body.warnings.includes('CONTENT_OMITTED'));
  const download = await f.request(`/api/document-shares/${created.share.id}/content`, { headers });
  assert.match(download.headers.get('content-disposition'), /attachment/i);
  assert.equal(isShareableDocument('docs/landing.xhtml'), true);
});

test('share URL uses only configured trusted origin', async (t) => {
  const f = await fixture(t);
  const app = express(); app.use(express.json());
  app.use('/api', createDocumentSharesRouter({ getStore: () => f.store, verifyUser: f.verifyUser,
    isMember: (_root, id) => f.members.has(id), publicOrigin: 'https://nassaj.example/evil' }));
  const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${origin}/api/projects/p1/document-shares`, { method: 'POST', headers: { ...f.authorization(1), Host: 'attacker.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: 'docs/proposal.txt', audience: 'client' }) });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: { code: 'SHARE_UNAVAILABLE' } });
  assert.equal(f.store.list('p1').length, 0);
});

test('HTML preview omits scope escapes and linked assets without reading them', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.base, 'secret.png'), 'MUST_NOT_LEAK');
  await fs.mkdir(path.join(f.root, 'docs', 'escape.assets'), { recursive: true });
  const linked = path.join(f.root, 'docs', 'escape.assets', 'linked.png');
  await fs.writeFile(linked, 'IN_SCOPE_WITNESS');
  assert.equal((await readSharedPageAsset(f.root, 'docs/escape.html', 'escape.assets/linked.png')).bytes.toString(), 'IN_SCOPE_WITNESS');
  await fs.unlink(linked);
  await fs.symlink(path.join(f.base, 'secret.png'), path.join(f.root, 'docs', 'escape.assets', 'linked.png'));
  await assert.rejects(readSharedPageAsset(f.root, 'docs/escape.html', 'escape.assets/linked.png'), { code: 'ELOOP' });
  await fs.writeFile(path.join(f.root, 'docs', 'escape.html'), '<img src="../secret.png"><img src="escape.assets/linked.png">');
  const response = await f.request('/api/projects/p1/document-shares', { method: 'POST', headers: { ...f.authorization(1), 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: 'docs/escape.html', audience: 'client' }) });
  const created = await response.json();
  const preview = await f.request(created.share.previewPath, { headers: { 'X-Share-Token': created.sharePath.split('token=')[1] } });
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.ok(!body.html.includes('MUST_NOT_LEAK'));
  assert.ok(!body.html.includes(Buffer.from('MUST_NOT_LEAK').toString('base64')));
  assert.deepEqual(body.warnings, ['RESOURCE_OMITTED']);
});

test('HTML preview enforces source, node, and embedded-output limits', async (t) => {
  const f = await fixture(t);
  const createPreview = async (name, html) => {
    await fs.writeFile(path.join(f.root, 'docs', name), html);
    const created = await (await f.request('/api/projects/p1/document-shares', { method: 'POST', headers: { ...f.authorization(1), 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: `docs/${name}`, audience: 'client' }) })).json();
    return f.request(created.share.previewPath, { headers: { 'X-Share-Token': created.sharePath.split('token=')[1] } });
  };
  assert.equal((await createPreview('large.html', 'x'.repeat(513 * 1024))).status, 413);
  assert.equal((await createPreview('nodes.html', '<i></i>'.repeat(10_001))).status, 413);
  await fs.mkdir(path.join(f.root, 'docs', 'embed.assets'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'docs', 'embed.assets', 'large.png'), Buffer.alloc(7 * 1024 * 1024));
  assert.equal((await createPreview('embed.html', '<img src="embed.assets/large.png">')).status, 413);
  const nested = await createPreview('deep.html', `<style>p { color: ${'calc('.repeat(200)}1${')'.repeat(200)} }</style><p>safe</p>`);
  assert.equal(nested.status, 200);
  const safe = await nested.json();
  assert.ok(safe.warnings.includes('STYLE_OMITTED'));
  assert.ok(!safe.html.includes('calc('));
});

test('CSS asset cache is scoped to its source directory and accepts safe inline raster data', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'docs', 'cache.assets', 'one'), { recursive: true });
  await fs.mkdir(path.join(f.root, 'docs', 'cache.assets', 'two'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'docs', 'cache.assets', 'one', 'same.png'), Buffer.from('one'));
  await fs.writeFile(path.join(f.root, 'docs', 'cache.assets', 'two', 'same.png'), Buffer.from('two'));
  await fs.writeFile(path.join(f.root, 'docs', 'cache.assets', 'one', 'site.css'), '.one{background:url(same.png)}');
  await fs.writeFile(path.join(f.root, 'docs', 'cache.assets', 'two', 'site.css'), '.two{background:url(same.png)}');
  const raster = 'data:image/png;base64,iVBORw0KGgo=';
  await fs.writeFile(path.join(f.root, 'docs', 'cache.html'), `<link rel="stylesheet" href="cache.assets/one/site.css"><link rel="stylesheet" href="cache.assets/two/site.css"><style>.inline{background:url(${raster})}</style>`);
  const created = await (await f.request('/api/projects/p1/document-shares', { method: 'POST', headers: { ...f.authorization(1), 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: 'docs/cache.html', audience: 'client' }) })).json();
  const preview = await (await f.request(created.share.previewPath, { headers: { 'X-Share-Token': created.sharePath.split('token=')[1] } })).json();
  assert.match(preview.html, /b25l/);
  assert.match(preview.html, /dHdv/);
  assert.match(preview.html, /data:image\/png;base64,iVBORw0KGgo=/);
});

test('preview rechecks membership after assembly before returning HTML', async (t) => {
  const reached = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let assembled = false;
  const builder = createSharedDocumentPreviewBuilder({ readDocument: async (...args) => {
    const source = await readSharedDocument(...args);
    reached.resolve();
    await resume.promise;
    return source;
  } });
  const f = await fixture(t, async (...args) => {
    const result = await builder(...args);
    assembled = true;
    return result;
  });
  await fs.mkdir(path.join(f.root, 'docs', 'check.assets'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'docs', 'check.html'), '<p>private</p>');
  const created = await (await f.request('/api/projects/p1/document-shares', { method: 'POST', headers: { ...f.authorization(1), 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: 'docs/check.html', audience: 'members' }) })).json();
  const response = f.request(created.share.previewPath, { headers: f.authorization(2) });
  await reached.promise;
  assert.equal(assembled, false);
  f.members.delete(2);
  resume.resolve();
  const denied = await response;
  assert.equal(assembled, true);
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: { code: 'ACCESS_DENIED' } });
});

test('real JWT and current membership are required, including after membership/account/password changes', async (t) => {
  const f = await fixture(t);
  const created = await f.create('members');
  const url = `/api/document-shares/${created.share.id}/content`;
  assert.equal((await f.request(url)).status, 401);
  assert.equal((await f.request('/api/document-shares/' + '0'.repeat(32))).status, 401);
  assert.equal((await f.request(url, { headers: f.authorization(3) })).status, 403);
  assert.equal((await f.request(url, { headers: f.authorization(2) })).status, 200);
  f.members.delete(2);
  assert.equal((await f.request(url, { headers: f.authorization(2) })).status, 403);
  f.members.add(2);
  f.users.get(2).status = 'disabled';
  assert.equal((await f.request(url, { headers: f.authorization(2) })).status, 401);
  f.users.get(2).status = 'active';
  f.users.get(2).password_changed_at = Date.now();
  assert.equal((await f.request(url, { headers: f.authorization(2) })).status, 401);
  const noStamp = jwt.sign({ userId: 2 }, secret, { expiresIn: '1h' });
  assert.equal(f.verifyUser(`Bearer ${noStamp}`), null);
  const forged = jwt.sign({ userId: 1 }, 'wrong-key', { expiresIn: '1h' });
  assert.equal(f.verifyUser(`Bearer ${forged}`), null);
  const expired = jwt.sign({ userId: 1 }, secret, { expiresIn: -1 });
  assert.equal(f.verifyUser(`Bearer ${expired}`), null);
  f.users.get(1).must_change_password = 1;
  assert.equal(f.verifyUser(f.authorization(1).Authorization), null);
});

test('revoke, expiry, unknown identifiers and missing files fail without local paths; HEAD and Range reauthorize', async (t) => {
  const f = await fixture(t);
  const { share, sharePath } = await f.create();
  const headers = { 'X-Share-Token': sharePath.split('token=')[1] };
  const url = `/api/document-shares/${share.id}/content`;
  assert.equal((await f.request(url, { method: 'HEAD', headers })).status, 200);
  assert.equal((await f.request(url, { headers: { ...headers, Range: 'bytes=0-2' } })).status, 416);
  assert.equal((await f.request(url, { headers: { 'X-Share-Token': 'x'.repeat(43) } })).status, 404);
  const revoke = `/api/projects/p1/document-shares/${share.id}/revoke`;
  assert.equal((await f.request(revoke, { method: 'POST', headers: f.authorization(3) })).status, 403);
  assert.equal((await f.request(revoke, { method: 'POST', headers: f.authorization(1) })).status, 204);
  assert.equal((await f.request(revoke, { method: 'POST', headers: f.authorization(1) })).status, 204);
  assert.equal((await f.request(url, { method: 'HEAD', headers })).status, 404);
  const another = await f.create();
  f.db.prepare('UPDATE document_shares SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z', another.share.id);
  assert.equal((await f.request(`/api/document-shares/${another.share.id}`, {
    headers: { 'X-Share-Token': another.sharePath.split('token=')[1] } })).status, 404);
  const missing = await f.create();
  await fs.unlink(path.join(f.root, 'docs/proposal.txt'));
  const response = await f.request(`/api/document-shares/${missing.share.id}`, {
    headers: { 'X-Share-Token': missing.sharePath.split('token=')[1] } });
  assert.deepEqual(await response.json(), { error: { code: 'SHARE_UNAVAILABLE' } });
  await fs.writeFile(path.join(f.root, 'docs/proposal.txt'), 'replacement needs explicit relink');
  const replacementHeaders = { 'X-Share-Token': missing.sharePath.split('token=')[1] };
  assert.equal((await f.request(`/api/document-shares/${missing.share.id}`, { headers: replacementHeaders })).status, 404);
  const relink = await f.request(`/api/projects/p1/document-shares/${missing.share.id}`, { method: 'PATCH',
    headers: { ...f.authorization(1), 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: 'docs/proposal.txt' }) });
  assert.equal(relink.status, 200);
  assert.equal((await f.request(`/api/document-shares/${missing.share.id}`, { headers: replacementHeaders })).status, 200);
});

test('only administrators manage, input is bounded and explicit relinking preserves the identifier', async (t) => {
  const f = await fixture(t);
  const post = (body, user = 1) => f.request('/api/projects/p1/document-shares', { method: 'POST',
    headers: { ...f.authorization(user), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ relativePath: 'docs/proposal.txt', audience: 'client' }, 2)).status, 403);
  for (const relativePath of ['../secret.txt', 'docs/../../secret.txt', 'docs/.env.txt', 'docs/%2e%2e/x.txt', 'docs/a.exe', '/etc/passwd']) {
    assert.equal((await post({ relativePath, audience: 'client' })).status, 400);
  }
  assert.equal((await post({ relativePath: 'docs/proposal.txt', audience: 'client', expiresAt: 'bad' })).status, 400);
  const { share } = await f.create('members');
  await fs.writeFile(path.join(f.root, 'docs', 'renamed.txt'), 'renamed');
  const updated = await f.request(`/api/projects/p1/document-shares/${share.id}`, { method: 'PATCH',
    headers: { ...f.authorization(1), 'Content-Type': 'application/json' }, body: JSON.stringify({ relativePath: 'docs/renamed.txt' }) });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).share.id, share.id);
  f.db.prepare('UPDATE projects SET isArchived=1').run();
  assert.equal((await f.request(`/api/document-shares/${share.id}`, { headers: f.authorization(1) })).status, 404);
});

test('descriptor reader refuses symlinks, hardlinks, FIFOs, oversize and changed project roots', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'secret.txt');
  await fs.writeFile(outside, 'MUST_NOT_LEAK');
  await fs.symlink(outside, path.join(f.root, 'docs', 'link.txt'));
  await assert.rejects(readSharedDocument(f.root, 'docs/link.txt'));
  await fs.symlink(f.base, path.join(f.root, 'docs', 'indirect'));
  await assert.rejects(readSharedDocument(f.root, 'docs/indirect/secret.txt'));
  await fs.link(outside, path.join(f.root, 'docs', 'hard.txt'));
  await assert.rejects(readSharedDocument(f.root, 'docs/hard.txt'));
  execFileSync('mkfifo', [path.join(f.root, 'docs', 'pipe.txt')]);
  await assert.rejects(readSharedDocument(f.root, 'docs/pipe.txt'));
  const big = await fs.open(path.join(f.root, 'docs', 'big.txt'), 'w');
  await big.truncate(DOCUMENT_MAX_BYTES + 1);
  await big.close();
  await assert.rejects(readSharedDocument(f.root, 'docs/big.txt'), { code: 'DOCUMENT_TOO_LARGE' });
  const identity = await inspectSharedDocument(f.root, 'docs/proposal.txt');
  await fs.rename(f.root, `${f.root}-old`);
  await fs.mkdir(path.join(f.root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(f.root, 'docs/proposal.txt'), 'MUST_NOT_LEAK');
  await assert.rejects(readSharedDocument(f.root, 'docs/proposal.txt', identity));
  assert.equal(isShareableDocument('docs/nested/عرض.md'), true);
  await assert.rejects(inspectSharedDocument('/tmp/project', 'docs/proposal.txt'));
});

test('atomic editor saves and aborted readers never expose a partial file; restore disables old capabilities', async (t) => {
  const f = await fixture(t);
  const old = 'a'.repeat(200000);
  const next = 'b'.repeat(200000);
  await saveSharedDocumentAtomically(f.root, 'docs/proposal.txt', old);
  const pending = readSharedDocument(f.root, 'docs/proposal.txt').catch((error) => {
    assert.equal(error.code, 'DOCUMENT_BUSY');
    return null;
  });
  await saveSharedDocumentAtomically(f.root, 'docs/proposal.txt', next);
  const bytes = await pending;
  if (bytes) assert.ok([old, next].includes(bytes.toString()));
  assert.equal((await readSharedDocument(f.root, 'docs/proposal.txt')).toString(), next);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(readSharedDocument(f.root, 'docs/proposal.txt', undefined, abort.signal), { code: 'REQUEST_CANCELLED' });
  const { share } = await f.create();
  const restored = new Database(f.db.serialize());
  f.store.revoke(share.id, new Date().toISOString());
  const restoredStore = createDocumentSharesStore(restored);
  assert.equal(restoredStore.get(share.id).revoked_at, null);
  restoredStore.disableRestored(new Date().toISOString());
  assert.ok(restoredStore.get(share.id).revoked_at);
  restored.close();
});

test('concurrent intermediate-directory replacement never serves outside content or leaks descriptors', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'proposal.txt'), 'OUTSIDE_MUST_NOT_LEAK');
  const docs = path.join(f.root, 'docs');
  const hold = path.join(f.root, 'held-docs');
  const baseline = (await fs.readdir('/proc/self/fd')).length;
  const swap = async () => {
    for (let i = 0; i < 35; i++) {
      await fs.rename(docs, hold);
      await fs.symlink(outside, docs);
      await fs.unlink(docs);
      await fs.rename(hold, docs);
    }
  };
  const probe = async () => {
    for (let i = 0; i < 50; i++) {
      try { assert.equal((await readSharedDocument(f.root, 'docs/proposal.txt')).toString(), 'first version'); }
      catch (error) { assert.ok(['ENOENT', 'ENOTDIR', 'ELOOP', 'DOCUMENT_BUSY'].includes(error.code), error.message); }
    }
  };
  await Promise.all([swap(), probe(), probe()]);
  assert.ok((await fs.readdir('/proc/self/fd')).length <= baseline);
});

test('rate limits are bounded and errors reveal neither credentials nor source paths', async (t) => {
  const f = await fixture(t);
  let last;
  for (let i = 0; i < 121; i++) last = await f.request('/api/document-shares/' + '0'.repeat(32));
  assert.equal(last.status, 429);
  assert.equal(last.headers.get('retry-after'), '60');
  assert.deepEqual(await last.json(), { error: { code: 'RATE_LIMITED' } });
});

test('active share quota applies atomically to renewal, creation and concurrent requests', async (t) => {
  const f = await fixture(t);
  const created = await f.create('members');
  const template = f.store.get(created.share.id);
  const expiredAt = '2000-01-01T00:00:00.000Z';
  f.db.prepare('UPDATE document_shares SET expires_at=? WHERE id=?').run(expiredAt, template.id);
  for (let i = 1; i <= 100; i++) {
    assert.equal(f.store.insert({ ...template, id: i.toString(16).padStart(32, '0') }).changes, 1);
  }
  const patch = (id, body) => f.request(`/api/projects/p1/document-shares/${id}`, { method: 'PATCH',
    headers: { ...f.authorization(1), 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const expiresAt of [null, new Date(Date.now() + 3600_000).toISOString()]) {
    const rejected = await patch(template.id, { expiresAt });
    assert.equal(rejected.status, 429);
    assert.equal((await rejected.json()).error.code, 'SHARE_LIMIT_REACHED');
    assert.equal(f.store.get(template.id).expires_at, expiredAt);
  }
  assert.equal(f.store.activeCount('p1'), 100);
  const activeId = '1'.padStart(32, '0');
  assert.equal((await patch(activeId, { expiresAt: null })).status, 200);
  assert.equal((await patch(template.id, { relativePath: 'docs/proposal.txt' })).status, 200);
  assert.equal(f.store.insert({ ...template, id: 'e'.repeat(32) }).changes, 0);
  const createdAtLimit = await f.request('/api/projects/p1/document-shares', { method: 'POST',
    headers: { ...f.authorization(1), 'Content-Type': 'application/json' },
    body: JSON.stringify({ relativePath: 'docs/proposal.txt', audience: 'members' }) });
  assert.equal(createdAtLimit.status, 429);
  const secondExpiredId = '2'.padStart(32, '0');
  f.db.prepare('UPDATE document_shares SET expires_at=? WHERE id=?').run(expiredAt, secondExpiredId);
  const competing = await Promise.all([patch(template.id, { expiresAt: null }), patch(secondExpiredId, { expiresAt: null })]);
  assert.deepEqual(competing.map((response) => response.status).sort(), [200, 429]);
  assert.equal(f.store.activeCount('p1'), 100);
  f.store.revoke(activeId, new Date().toISOString());
  assert.equal((await patch(activeId, { expiresAt: null })).status, 404);
});
