/**
 * Test-only builders for office packages. All packages here are SYNTHETIC:
 * minimal OOXML/ODF parts laid out the way Word/Excel/LibreOffice write them,
 * built in memory so every byte under test is visible in the test source.
 */
import { createDeflateRaw } from 'node:zlib';

import JSZip from 'jszip';

import { OfficePackage } from '../zipXml';

export const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
export const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
export const CT_NS = 'http://schemas.openxmlformats.org/package/2006/content-types';
const REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** A valid 1×1 PNG. */
export const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
export const PNG_1X1 = Uint8Array.from(atob(PNG_1X1_BASE64), (char) => char.charCodeAt(0));

export type PackageFiles = Record<string, string | Uint8Array>;

/** Zips files in memory (DEFLATE). */
export async function zipBytes(files: PackageFiles): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(files)) zip.file(path, content);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

/** Zips files and opens them as a bounded OfficePackage. */
export async function openFiles(files: PackageFiles, signal?: AbortSignal): Promise<OfficePackage> {
  return OfficePackage.open(await zipBytes(files), signal);
}

/** XML-escapes text for use inside an attribute or element. */
export const xmlEscape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Raw DEFLATE of `totalBytes` zero bytes, produced in 1 MiB steps (small memory). */
export function deflatedZeros(totalBytes: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const deflate = createDeflateRaw({ level: 9 });
    const chunks: Buffer[] = [];
    deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
    deflate.on('error', reject);
    deflate.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    const step = Buffer.alloc(1024 * 1024);
    let written = 0;
    const pump = () => {
      while (written < totalBytes) {
        written += step.length;
        if (!deflate.write(step)) {
          deflate.once('drain', pump);
          return;
        }
      }
      deflate.end();
    };
    pump();
  });
}

/**
 * Hand-writes a single-entry zip whose headers LIE about the inflated size,
 * the way a zip bomb hides from declared-size checks. CRC is not checked by
 * JSZip on load, so it is left zero.
 */
export function lyingZip(name: string, deflated: Uint8Array, declaredSize: number): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true);
  local.setUint16(8, 8, true); // DEFLATE
  local.setUint32(18, deflated.length, true);
  local.setUint32(22, declaredSize, true);
  local.setUint16(26, nameBytes.length, true);
  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true);
  central.setUint16(6, 20, true);
  central.setUint16(10, 8, true);
  central.setUint32(20, deflated.length, true);
  central.setUint32(24, declaredSize, true);
  central.setUint16(28, nameBytes.length, true);
  central.setUint32(42, 0, true); // local header offset
  const centralOffset = 30 + nameBytes.length + deflated.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, 46 + nameBytes.length, true);
  end.setUint32(16, centralOffset, true);
  const parts = [new Uint8Array(local.buffer), nameBytes, deflated, new Uint8Array(central.buffer), nameBytes, new Uint8Array(end.buffer)];
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

type DocxParts = {
  body: string;
  styles?: string;
  fontTable?: string;
  theme?: string;
  numbering?: string;
  media?: Record<string, Uint8Array>;
  /** Content type declared for media (attacker-controlled in real files). */
  mediaContentType?: string;
  extra?: PackageFiles;
};

/** Builds a Word-structured .docx package (synthetic) from its parts. */
export function docxFiles({ body, styles, fontTable, theme, numbering, media = {}, mediaContentType = 'image/png', extra = {} }: DocxParts): PackageFiles {
  const rels: string[] = [];
  const overrides: string[] = [];
  const addPart = (id: string, type: string, target: string, contentType: string) => {
    rels.push(`<Relationship Id="${id}" Type="${REL_TYPE}/${type}" Target="${target}"/>`);
    overrides.push(`<Override PartName="/word/${target}" ContentType="${contentType}"/>`);
  };
  const files: PackageFiles = {
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:a="${A_NS}"
  xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
  xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${body}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
</w:body></w:document>`,
  };
  const ooxml = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
  if (styles) {
    files['word/styles.xml'] = `<w:styles xmlns:w="${W_NS}">${styles}</w:styles>`;
    addPart('rIdStyles', 'styles', 'styles.xml', `${ooxml}.styles+xml`);
  }
  if (fontTable) {
    files['word/fontTable.xml'] = `<w:fonts xmlns:w="${W_NS}" xmlns:r="${R_NS}">${fontTable}</w:fonts>`;
    addPart('rIdFonts', 'fontTable', 'fontTable.xml', `${ooxml}.fontTable+xml`);
  }
  if (theme) {
    files['word/theme/theme1.xml'] = `<a:theme xmlns:a="${A_NS}" name="T"><a:themeElements>${theme}</a:themeElements></a:theme>`;
    addPart('rIdTheme', 'theme', 'theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml');
  }
  if (numbering) {
    files['word/numbering.xml'] = `<w:numbering xmlns:w="${W_NS}">${numbering}</w:numbering>`;
    addPart('rIdNumbering', 'numbering', 'numbering.xml', `${ooxml}.numbering+xml`);
  }
  for (const [name, bytes] of Object.entries(media)) {
    files[`word/media/${name}`] = bytes;
    rels.push(`<Relationship Id="rIdImg_${name.replace(/\W/g, '')}" Type="${REL_TYPE}/image" Target="media/${name}"/>`);
  }
  files['word/_rels/document.xml.rels'] = `<Relationships xmlns="${PKG_REL_NS}">${rels.join('')}</Relationships>`;
  files['_rels/.rels'] = `<Relationships xmlns="${PKG_REL_NS}"><Relationship Id="rId1" Type="${REL_TYPE}/officeDocument" Target="word/document.xml"/></Relationships>`;
  files['[Content_Types].xml'] = `<Types xmlns="${CT_NS}">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="${mediaContentType}"/>
<Override PartName="/word/document.xml" ContentType="${ooxml}.document.main+xml"/>${overrides.join('')}</Types>`;
  return { ...files, ...extra };
}

/** A paragraph run, optionally right-to-left (Word writes w:bidi + w:rtl for Arabic). */
export const wPara = (text: string, { rtl = false, style }: { rtl?: boolean; style?: string } = {}): string =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${xmlEscape(style)}"/>` : ''}${rtl ? '<w:bidi/>' : ''}</w:pPr>`
  + `<w:r>${rtl ? '<w:rPr><w:rtl/></w:rPr>' : ''}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;

/** An inline picture referencing a media relationship. */
export const wPicture = (name: string): string => `<w:p><w:r><w:drawing><wp:inline>
<wp:extent cx="95250" cy="95250"/><wp:docPr id="1" name="p"/>
<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>
<pic:nvPicPr><pic:cNvPr id="0" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr>
<pic:blipFill><a:blip r:embed="rIdImg_${name.replace(/\W/g, '')}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>
<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="95250" cy="95250"/></a:xfrm><a:prstGeom prst="rect"/></pic:spPr>
</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
