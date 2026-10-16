/**
 * RUNNER: vitest (`npm run test:client`) — jsdom.
 * Untrusted document HTML/CSS must lose scripts, handlers and network URLs,
 * and the srcdoc must have exactly the expected structure (C1, C8, C12).
 */
import { describe, expect, it } from 'vitest';

import { DOCUMENT_PREVIEW_CSP, buildPreviewSrcdoc, previewChromeCss } from './previewSrcdoc';
import { sanitizeDocument, sanitizeDocumentHtml } from './sanitizeDocumentHtml';
import { PNG_1X1_BASE64 } from './testing/officeFixtures';

const PIXEL = `data:image/png;base64,${PNG_1X1_BASE64}`;

describe('sanitizeDocumentHtml', () => {
  it('removes scripts, event handlers and embedded frames', () => {
    const html = sanitizeDocumentHtml(
      `<p onclick="x()">a</p><script>alert(1)</script><img src="${PIXEL}" onerror="x()"><iframe srcdoc="<b>"></iframe><form><input></form>`,
    );
    expect(html).not.toMatch(/script|onclick|onerror|iframe|<form|<input/i);
    expect(html).toContain(PIXEL);
  });

  it('makes links inert but keeps in-document anchors', () => {
    const html = sanitizeDocumentHtml('<a href="javascript:alert(1)">j</a><a href="https://evil.test/x" target="_blank">e</a><a href="#sec">s</a>');
    const container = document.createElement('div');
    container.innerHTML = html;
    const [js, external, anchor] = Array.from(container.querySelectorAll('a'));
    expect(js.hasAttribute('href')).toBe(false);
    expect(external.hasAttribute('href')).toBe(false);
    expect(external.hasAttribute('target')).toBe(false);
    expect(external.getAttribute('title')).toBe('https://evil.test/x');
    expect(anchor.getAttribute('href')).toBe('#sec');
  });

  it('drops external images, srcset and svg external references', () => {
    const html = sanitizeDocumentHtml(
      '<img src="https://evil.test/p.png" srcset="https://evil.test/a.png 1x"><svg><image href="https://evil.test/i.png"></image><use xlink:href="https://evil.test/u.svg#a"></use></svg>',
    );
    expect(html).not.toContain('evil.test');
  });

  it('strips non-data url() from inline styles, including escaped forms', () => {
    const html = sanitizeDocumentHtml(
      `<p style="background:url(https://evil.test/b.png);color:red">x</p><p style="background:\\75rl(//evil.test/c)">z</p><p style="background-image:url('${PIXEL}')">y</p>`,
    );
    expect(html).not.toContain('evil.test');
    expect(html).toContain('color:red');
    expect(html).toContain(PIXEL);
  });

  it('C8: removes SVG/CSS presentation attributes that reference resources', () => {
    const html = sanitizeDocumentHtml(
      '<svg><rect fill="url(http://evil.test/f#a)" stroke="\\75rl(//evil.test/s)" filter="url(https://evil.test/x)" '
      + 'mask="url(//evil.test/m)" clip-path="url(//evil.test/c)" marker-end="url(//evil.test/k)"></rect>'
      + '<circle fill="url(#grad)" stroke="red"></circle></svg>',
    );
    expect(html).not.toContain('evil.test');
    expect(html).toContain('fill="url(#grad)"');
    expect(html).toContain('stroke="red"');
  });

  it('C12: re-tags embedded images by magic bytes and drops non-raster data', () => {
    const container = document.createElement('div');
    container.innerHTML = sanitizeDocumentHtml(
      `<img id="a" src="data:application/octet-stream;base64,${PNG_1X1_BASE64}">`
      + '<img id="b" src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">'
      + '<img id="c" src="data:image/png;base64,PGh0bWw+">',
    );
    expect(container.querySelector('#a')?.getAttribute('src')).toBe(PIXEL);
    expect(container.querySelector('#b')?.hasAttribute('src')).toBe(false);
    expect(container.querySelector('#c')?.hasAttribute('src')).toBe(false);
  });
});

describe('buildPreviewSrcdoc — structure', () => {
  const hostileCss = '.docx_a</</stylestyle><script>alert(1)</script>{color:red} </style><img src=x onerror=alert(2)>';
  const hostileBody = '<p>hi</p><script>alert(3)</script><style>p{}</style><meta http-equiv="refresh" content="0;url=https://evil.test">';

  it('has exactly charset, CSP (first after charset), viewport and two styles in head', () => {
    const sanitized = sanitizeDocument({ bodyHtml: hostileBody, css: hostileCss });
    for (const dark of [false, true]) {
      const parsed = new DOMParser().parseFromString(buildPreviewSrcdoc(sanitized, dark), 'text/html');
      const head = Array.from(parsed.head.children);
      expect(head.map((element) => element.tagName)).toEqual(['META', 'META', 'META', 'STYLE', 'STYLE']);
      expect(head[0].getAttribute('charset')).toBe('utf-8');
      expect(head[1].getAttribute('http-equiv')).toBe('Content-Security-Policy');
      expect(head[1].getAttribute('content')).toBe(DOCUMENT_PREVIEW_CSP);
      expect(head[2].getAttribute('name')).toBe('viewport');
      expect(head[3].textContent).toBe(sanitized.css);
      expect(head[4].textContent).toBe(previewChromeCss(dark));
      expect(parsed.body.innerHTML).toBe(sanitized.bodyHtml);
      expect(parsed.querySelectorAll('script, img[onerror], meta[http-equiv="refresh"]')).toHaveLength(0);
      expect(parsed.querySelectorAll('style')).toHaveLength(2);
    }
  });

  it('pins a CSP that blocks scripts and network loads', () => {
    expect(DOCUMENT_PREVIEW_CSP).toContain("default-src 'none'");
    expect(DOCUMENT_PREVIEW_CSP).not.toMatch(/script-src|https?:/);
  });
});
