import assert from 'node:assert/strict';
import test from 'node:test';

import mime from 'mime-types';

import { RAW_FILE_CSP, applyRawFileResponseHeaders, isActiveDocumentType } from './raw-file-response-headers.js';

function headersFor(mimeType) {
  const headers = {};
  applyRawFileResponseHeaders({ setHeader: (name, value) => { headers[name] = value; } }, mimeType);
  return headers;
}

test('every raw-bytes response is nosniff and sandboxed, whatever its type', () => {
  for (const type of ['image/png', 'application/pdf', 'text/plain', 'application/octet-stream', 'video/mp4']) {
    const headers = headersFor(type);
    assert.equal(headers['Content-Type'], type);
    assert.equal(headers['X-Content-Type-Options'], 'nosniff');
    assert.equal(headers['Content-Security-Policy'], RAW_FILE_CSP);
    assert.match(RAW_FILE_CSP, /\bsandbox\b/);
    assert.equal(headers['Content-Disposition'], undefined, `${type} still previews inline`);
  }
});

test('active document types download, including every +xml dialect (M9)', () => {
  const names = ['a.html', 'a.htm', 'a.shtml', 'a.xhtml', 'a.svg', 'a.xml', 'a.xsl', 'a.rdf', 'a.atom', 'a.mml', 'a.xslt'];
  for (const name of names) {
    const type = mime.lookup(name);
    assert.ok(type, name);
    assert.equal(isActiveDocumentType(type), true, `${name} -> ${type}`);
    assert.equal(headersFor(type)['Content-Disposition'], 'attachment', name);
  }
  assert.equal(isActiveDocumentType('Image/SVG+XML; charset=utf-8'), true, 'case and parameters are normalized');
  assert.equal(isActiveDocumentType('application/json'), false);
  assert.equal(isActiveDocumentType(undefined), false);
});

test('the raw project-file route uses these headers', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/api/projects/:projectId/files/content'");
  assert.ok(start > 0);
  const handler = source.slice(start, source.indexOf('\napp.', start + 1));
  assert.match(handler, /applyRawFileResponseHeaders\(res, /);
  assert.doesNotMatch(handler, /setHeader\('Content-Type'/, 'no private copy of the header policy');
});
