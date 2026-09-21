import assert from 'node:assert/strict';
import test from 'node:test';

import { renderSharedDocumentPreview } from './document-share-preview-renderer.js';
import { PreviewProtocolError } from './document-share-preview-protocol.js';

const render = (html, readAsset = async () => { throw new PreviewProtocolError('SHARE_UNAVAILABLE'); }) =>
  renderSharedDocumentPreview(Buffer.from(html), 'docs/page.html', readAsset);

test('renderer strips active content and inlines scoped CSS, raster and fonts with cached assets', async () => {
  let reads = 0;
  const output = await render('<script>alert(1)</script><iframe></iframe><svg></svg><form></form><a href="https://bad">go</a><p onclick="x()" style="color:red">safe</p>'
    + '<link rel="icon" href="x.ico"><link rel="stylesheet" href="page.assets/site.css"><link rel="stylesheet" href="page.assets/site.css">'
    + '<img src="page.assets/ok.png"><img src="page.assets/ok.png"><img src="https://bad/x.png">',
  async (reference, kind) => {
    reads++;
    if (reference.startsWith('https:')) throw new PreviewProtocolError('SHARE_UNAVAILABLE');
    return { bytes: Buffer.from(kind === 'css'
      ? '@import "https://bad/style"; @font-face{src:url(font.woff2)} .a{background:url(ok.png)}' : 'asset') };
  });
  assert.doesNotMatch(output.html, /script|iframe|onclick|<form|<svg|https:|style=/);
  assert.match(output.html, /data:font\/woff2;base64/);
  assert.match(output.html, /data:image\/png;base64/);
  assert.ok(reads < 8);
  assert.ok(output.warnings.includes('CONTENT_OMITTED'));
  assert.ok(output.warnings.includes('STYLE_OMITTED'));
  assert.ok(output.warnings.includes('RESOURCE_OMITTED'));
});

test('renderer rejects unknown types, remote/query/hash URLs and invalid inline raster signatures', async () => {
  const output = await render('<img src="page.assets/x.svg"><img src="page.assets/x.png?q=1"><img src="page.assets/x.png#x">'
    + '<img src="data:image/png;base64,YmFk"><img src="data:image/png;base64,iVBORw0KGgo=">'
    + '<img src="data:image/jpeg;base64,/9j/AA=="><img src="data:image/gif;base64,R0lGODlh">'
    + '<img src="data:image/webp;base64,UklGRgAAAABXRUJQ"><img src="data:image/avif;base64,AAAAAGZ0eXA=">');
  assert.deepEqual(output.warnings, ['RESOURCE_OMITTED']);
  assert.equal((output.html.match(/<img/g) ?? []).length, 5);
});

test('CSS byte, declaration, AST depth, invalid syntax and unsupported functions fail closed', async () => {
  const styles = [
    'x'.repeat(256 * 1024 + 1),
    `p{${'color:red;'.repeat(2001)}}`,
    '@media x{'.repeat(34) + 'p{color:red}' + '}'.repeat(34),
    'p{color:',
    `p{color:${'calc('.repeat(40)}1${')'.repeat(40)}}`,
    'p{background:image-set(url(x.png) 1x)}',
    'p{background:cross-fade(url(x.png),url(y.png),50%)}',
  ];
  for (const css of styles) {
    const output = await render(`<style>${css}</style><p>safe</p>`);
    assert.ok(output.warnings.includes('STYLE_OMITTED'), css.slice(0, 80));
  }
});

test('CSS resource omissions, safe inline data and missing stylesheet preserve nonexecutable output', async () => {
  const output = await render('<link rel="stylesheet" href="page.assets/missing.css">'
    + '<style>.a{background:url(missing.png)}.b{color:red;background:url("data:image/png;base64,iVBORw0KGgo=")}</style>');
  assert.match(output.html, /color:red/);
  assert.match(output.html, /data:image\/png/);
  assert.doesNotMatch(output.html, /missing/);
  assert.ok(output.warnings.includes('RESOURCE_OMITTED'));
});

test('renderer source, nodes, unique resources, aggregate raw bytes and expanded-output limits stay enforced', async () => {
  await assert.rejects(render('x'.repeat(512 * 1024 + 1)), { status: 413 });
  await assert.rejects(render('<i></i>'.repeat(10_001)), { status: 413 });
  await assert.rejects(render(Array.from({ length: 65 }, (_, i) => `<img src="page.assets/${i}.png">`).join(''),
    async () => ({ bytes: Buffer.alloc(1) })), { status: 413 });
  await assert.rejects(render('<img src="page.assets/large.png">', async () => ({ bytes: Buffer.alloc(25 * 1024 * 1024) })), { status: 413 });
  await assert.rejects(render('<img src="page.assets/large.png">', async () => ({ bytes: Buffer.alloc(7 * 1024 * 1024) })), { status: 413 });
  await assert.rejects(render('<img src="page.assets/broken.png">', async () => { throw new Error('read failure'); }), /read failure/);
});
