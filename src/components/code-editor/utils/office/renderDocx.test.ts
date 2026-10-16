/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * End-to-end Word rendering through docx-preview 0.4.1 with SYNTHETIC
 * Word-structured packages: crafted payloads in style ids, font names, theme
 * typefaces and numbering level text must never escape into the srcdoc (C1);
 * rendering never touches the live document (C10); RTL tables, images (C12)
 * and macro-enabled variants.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { parseOfficeFile } from './parseOfficeFile';
import { MAX_IMAGE_BYTES, looksLikeXml, renderDocx } from './renderDocx';
import { sanitizeCssText } from './cssSanitizer';
import { DOCUMENT_PREVIEW_CSP, buildPreviewSrcdoc, previewChromeCss, type SanitizedDocument } from './previewSrcdoc';
import { PNG_1X1, PNG_1X1_BASE64, docxFiles, openFiles, wPara, wPicture, xmlEscape, zipBytes } from './testing/officeFixtures';

const BREAKOUT = '</</stylestyle><script>alert(1)</script></style><img src=x onerror=alert(2)>';
const NETWORK = ';}*{background:url(http://evil.test/css)}@import "http://evil.test/i.css";';

const hostileDocx = () => docxFiles({
  styles: `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:type="paragraph" w:styleId="${xmlEscape(`Evil${BREAKOUT}`)}"><w:name w:val="Evil"/>
      <w:rPr><w:rFonts w:ascii="${xmlEscape(`Font ${BREAKOUT}${NETWORK}`)}"/><w:color w:val="FF0000"/></w:rPr></w:style>`,
  fontTable: `<w:font w:name="${xmlEscape(`Table Font${BREAKOUT}`)}"><w:family w:val="roman"/></w:font>`,
  theme: `<a:fontScheme name="F"><a:majorFont><a:latin typeface="${xmlEscape(`Major ${BREAKOUT}${NETWORK}`)}"/></a:majorFont>
    <a:minorFont><a:latin typeface="${xmlEscape(`Minor ${BREAKOUT}`)}"/></a:minorFont></a:fontScheme>`,
  numbering: `<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>
      <w:lvlText w:val="${xmlEscape(`%1${BREAKOUT}`)}"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum>
    <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
  body: `${wPara('styled', { style: `Evil${BREAKOUT}` })}
    <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>listed</w:t></w:r></w:p>
    <w:p><w:hyperlink r:id="rIdLink"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>`,
});

/** Asserts the srcdoc parses to exactly the fixed head plus the sanitized body. */
function expectSafeSrcdoc(sanitized: SanitizedDocument): Document {
  const parsed = new DOMParser().parseFromString(buildPreviewSrcdoc(sanitized, false), 'text/html');
  const head = Array.from(parsed.head.children);
  expect(head.map((element) => element.tagName)).toEqual(['META', 'META', 'META', 'STYLE', 'STYLE']);
  expect(head[0].getAttribute('charset')).toBe('utf-8');
  expect(head[1].getAttribute('content')).toBe(DOCUMENT_PREVIEW_CSP);
  expect(head[3].textContent).toBe(sanitized.css);
  expect(head[4].textContent).toBe(previewChromeCss(false));
  expect(parsed.body.innerHTML).toBe(sanitized.bodyHtml);
  expect(parsed.querySelectorAll('script, iframe, object, embed, [onerror], [onload]')).toHaveLength(0);
  expect(sanitized.css).not.toContain('<');
  // Idempotent: every url() left is already a canonical data:/#fragment one
  // (anything else would be rewritten to `none`), and no @import remains.
  expect(sanitizeCssText(sanitized.css)).toBe(sanitized.css);
  expect(sanitized.bodyHtml).not.toContain('evil.test/css');
  return parsed;
}

describe('renderDocx', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('C1: payloads in styleId, font names, theme typeface and levelText stay inside CSS', async () => {
    const files = hostileDocx();
    files['word/_rels/document.xml.rels'] = files['word/_rels/document.xml.rels'].toString().replace(
      '</Relationships>',
      '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://evil.test/x" TargetMode="External"/></Relationships>',
    );
    const sanitized = await renderDocx(await openFiles(files));
    const parsed = expectSafeSrcdoc(sanitized);
    // The payload text is still present, but only as inert escaped CSS.
    expect(sanitized.css).toContain('\\3c script');
    expect(parsed.body.textContent).toContain('styled');
    expect(parsed.body.textContent).toContain('listed');
    expect(parsed.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('C10: never creates elements on the live document', async () => {
    const pkg = await openFiles(hostileDocx());
    const createElement = vi.spyOn(document, 'createElement');
    const createElementNS = vi.spyOn(document, 'createElementNS');
    await renderDocx(pkg);
    expect(createElement).not.toHaveBeenCalled();
    expect(createElementNS).not.toHaveBeenCalled();
  });

  it('renders Arabic right-to-left paragraphs and bidiVisual tables', async () => {
    const table = `<w:tbl><w:tblPr><w:bidiVisual/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>
      <w:tr><w:tc>${wPara('البند', { rtl: true })}</w:tc><w:tc>${wPara('المبلغ', { rtl: true })}</w:tc></w:tr></w:tbl>`;
    const sanitized = await renderDocx(await openFiles(docxFiles({
      body: `${wPara('سياسة التشغيل الداخلية', { rtl: true })}${table}${wPara('Latin paragraph')}`,
    })));
    const parsed = expectSafeSrcdoc(sanitized);
    expect(parsed.body.textContent).toContain('سياسة التشغيل الداخلية');
    expect(parsed.querySelector('table')?.getAttribute('dir')).toBe('rtl');
    expect(parsed.querySelector('p')?.getAttribute('dir') ?? parsed.querySelector('p')?.getAttribute('style')).toMatch(/rtl/);
  });

  it('C12: shows embedded images even when the package mislabels their type', async () => {
    const sanitized = await renderDocx(await openFiles(docxFiles({
      body: wPicture('image1.png'),
      media: { 'image1.png': PNG_1X1 },
      mediaContentType: 'application/octet-stream',
    })));
    const parsed = expectSafeSrcdoc(sanitized);
    expect(parsed.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${PNG_1X1_BASE64}`);
  });

  it('C7: leaves out media beyond the total image budget', async () => {
    const tenMiB = new Uint8Array(10 * 1024 * 1024);
    tenMiB.set(PNG_1X1);
    expect(3 * tenMiB.length).toBeGreaterThan(MAX_IMAGE_BYTES);
    const sanitized = await renderDocx(await openFiles(docxFiles({
      body: `${wPicture('a.png')}${wPicture('b.png')}${wPicture('c.png')}`,
      media: { 'a.png': tenMiB, 'b.png': tenMiB, 'c.png': tenMiB },
    })));
    const images = new DOMParser().parseFromString(sanitized.bodyHtml, 'text/html').querySelectorAll('img[src]');
    expect(images).toHaveLength(2);
  }, 30_000);

  it('M2: counts images outside media/ (any relationship target) toward the image budget', async () => {
    const tenMiB = new Uint8Array(10 * 1024 * 1024);
    tenMiB.set(PNG_1X1);
    const files = docxFiles({
      body: `${wPicture('a.png')}${wPicture('b.png')}${wPicture('c.png')}`,
      media: { 'a.png': tenMiB, 'b.png': tenMiB, 'c.png': tenMiB },
    });
    for (const name of ['a.png', 'b.png', 'c.png']) {
      files[`word/pics/${name}`] = files[`word/media/${name}`];
      delete files[`word/media/${name}`];
    }
    files['word/_rels/document.xml.rels'] = files['word/_rels/document.xml.rels'].toString().replace(/media\//g, 'pics/');
    const sanitized = await renderDocx(await openFiles(files));
    const images = new DOMParser().parseFromString(sanitized.bodyHtml, 'text/html').querySelectorAll('img[src]');
    expect(images).toHaveLength(2);
  }, 30_000);

  it('M2: classifies parts by content, so binary data named .xml still counts toward the budget', async () => {
    const tenMiB = new Uint8Array(10 * 1024 * 1024);
    tenMiB.set(PNG_1X1);
    const files = docxFiles({
      body: `${wPicture('a.png')}${wPicture('b.png')}${wPicture('c.png')}`,
      media: { 'a.png': tenMiB, 'b.png': tenMiB, 'c.png': tenMiB },
    });
    for (const name of ['a', 'b', 'c']) {
      files[`word/media/${name}.xml`] = files[`word/media/${name}.png`];
      delete files[`word/media/${name}.png`];
    }
    files['word/_rels/document.xml.rels'] = files['word/_rels/document.xml.rels'].toString().replace(/\.png"/g, '.xml"');
    const sanitized = await renderDocx(await openFiles(files));
    const images = new DOMParser().parseFromString(sanitized.bodyHtml, 'text/html').querySelectorAll('img[src]');
    expect(images).toHaveLength(2);
  }, 30_000);

  it('looksLikeXml accepts XML after BOMs/whitespace and rejects binary', () => {
    const bytes = (...values: number[]) => new Uint8Array(values);
    expect(looksLikeXml(new TextEncoder().encode('  \n<?xml?>'))).toBe(true);
    expect(looksLikeXml(bytes(0xef, 0xbb, 0xbf, 0x3c))).toBe(true);
    expect(looksLikeXml(bytes(0xff, 0xfe, 0x20, 0x00, 0x3c, 0x00))).toBe(true);
    expect(looksLikeXml(bytes(0xfe, 0xff, 0x00, 0x3c))).toBe(true);
    expect(looksLikeXml(PNG_1X1)).toBe(false);
    expect(looksLikeXml(bytes())).toBe(false);
  });

  it('H1: VML shape style and fill payloads are neutralized', async () => {
    const vml = 'urn:schemas-microsoft-com:vml';
    // docx-preview sizes VML in a requestAnimationFrame via getBBox, which jsdom lacks.
    Object.defineProperty(SVGElement.prototype, 'getBBox', { configurable: true, value: () => ({ x: 0, y: 0, width: 0, height: 0 }) });
    onTestFinished(async () => {
      await new Promise((resolve) => { requestAnimationFrame(resolve); });
      delete (SVGElement.prototype as { getBBox?: unknown }).getBBox;
    });
    const sanitized = await renderDocx(await openFiles(docxFiles({
      body: `<w:p><w:r><w:pict><v:shape xmlns:v="${vml}" style="position:absolute;width:20pt;height:20pt;background:\\&lt;url(http://evil.example/v);list-style:\\&lt;image-set('http://evil.example/i' 1x)" fillcolor="\\&lt;url(http://evil.example/f)"><v:fill/></v:shape><v:rect xmlns:v="${vml}" style="background:url(http://evil.example/r)"/></w:pict></w:r></w:p>`,
    })));
    expectSafeSrcdoc(sanitized);
    expect(sanitized.bodyHtml).not.toContain('evil.example');
  });

  it('maps private-use Symbol/Wingdings bullets to visible Unicode', async () => {
    const lvl = (ilvl: number, text: string, font: string) => `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="bullet"/>
      <w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:hint="default"/></w:rPr></w:lvl>`;
    const sanitized = await renderDocx(await openFiles(docxFiles({
      numbering: `<w:abstractNum w:abstractNumId="0">${lvl(0, '&#xF0B7;', 'Symbol')}${lvl(1, '&#xF0A7;', 'Wingdings')}${lvl(2, '&#xF0D8;', 'Wingdings')}</w:abstractNum>
        <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>`,
      body: [0, 1, 2].map((ilvl) => `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>item ${ilvl}</w:t></w:r></w:p>`).join(''),
    })));
    expect(sanitized.css).toContain('\u2022');
    expect(sanitized.css).toContain('\u25AA');
    expect(sanitized.css).toContain('\u27A2');
    expect(sanitized.css).not.toMatch(/[\uF000-\uF0FF]/);
  });

  it('renders macro-enabled .docm without ever reading the VBA project', async () => {
    const files = docxFiles({ body: wPara('macro doc'), extra: { 'word/vbaProject.bin': 'Attribute VB_Name = "x"' } });
    const result = await parseOfficeFile('docx', await zipBytes(files));
    expect(result.kind).toBe('document');
    if (result.kind === 'document') {
      expect(result.document.bodyHtml).toContain('macro doc');
      expect(result.document.bodyHtml).not.toContain('VB_Name');
    }
  });

  it('rejects a document part that declares a DTD', async () => {
    const files = docxFiles({ body: wPara('x') });
    files['word/document.xml'] = `<!DOCTYPE d [<!ENTITY a "aaaa">]>${files['word/document.xml'].toString().replace(/^<\?xml[^>]*>/, '')}`;
    await expect(renderDocx(await openFiles(files))).rejects.toThrow(/DTD/);
  });

  it('stops when cancelled before rendering', async () => {
    const controller = new AbortController();
    const pkg = await openFiles(docxFiles({ body: wPara('x') }));
    controller.abort();
    await expect(renderDocx(pkg, controller.signal)).rejects.toThrow(/cancelled/);
  });
});

const fixture = (name: string) => join(dirname(fileURLToPath(import.meta.url)), 'testing/fixtures', name);

// The binary Office fixtures stay out of the public export (its leak gate cannot
// scan ZIP containers), so the case skips only where the file is absent.
const ARABIC_DOCX = fixture('arabic-rtl.docx');

describe('renderDocx with the Arabic fixture', () => {
  it.skipIf(!existsSync(ARABIC_DOCX))('renders the committed Word-structured Arabic document', async () => {
    const result = await parseOfficeFile('docx', new Uint8Array(readFileSync(ARABIC_DOCX)));
    expect(result.kind).toBe('document');
    if (result.kind !== 'document') return;
    const parsed = expectSafeSrcdoc(result.document);
    expect(parsed.body.textContent).toContain('سياسة التشغيل');
    expect(parsed.querySelector('table')?.getAttribute('dir')).toBe('rtl');
  });
});
