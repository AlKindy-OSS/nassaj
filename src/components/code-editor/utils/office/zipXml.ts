import JSZip from 'jszip';

import { throwIfAborted } from './cancellation';

// Zip-bomb guards. Declared sizes in a zip are attacker-controlled, so every
// part is inflated through a stream that counts the bytes actually produced
// and stops the moment a cap is crossed.
export const MAX_ZIP_ENTRIES = 3000;
export const MAX_PART_BYTES = 16 * 1024 * 1024;
export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

export class OfficeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeParseError';
  }
}

/** Minimal shape of JSZip's internal StreamHelper (untyped in jszip's d.ts). */
type ZipStream = {
  on(event: 'data', listener: (chunk: Uint8Array) => void): ZipStream;
  on(event: 'end', listener: () => void): ZipStream;
  on(event: 'error', listener: (error: Error) => void): ZipStream;
  pause(): ZipStream;
  resume(): ZipStream;
};

const openStream = (entry: JSZip.JSZipObject): ZipStream =>
  (entry as unknown as { internalStream(type: 'uint8array'): ZipStream }).internalStream('uint8array');

const declaredSize = (entry: JSZip.JSZipObject): number =>
  (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;

/**
 * Inflates one entry, aborting as soon as more than `limit` bytes, or more
 * than the entry's own declared size, come out. Every failure (including
 * JSZip's internal ones) surfaces as an OfficeParseError.
 */
export function inflateBounded(entry: JSZip.JSZipObject, limit: number): Promise<Uint8Array> {
  const declared = declaredSize(entry);
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const stream = openStream(entry);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      stream.pause();
      reject(error);
    };
    stream
      .on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > limit) fail(new OfficeParseError(`Part inflates past the preview limit: ${entry.name}`));
        else if (total > declared) fail(new OfficeParseError(`Part inflates past its declared size: ${entry.name}`));
        else chunks.push(chunk);
      })
      .on('error', (error) => fail(error instanceof OfficeParseError ? error : new OfficeParseError(`Inflate failed: ${entry.name}`)))
      .on('end', () => {
        if (settled) return;
        settled = true;
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        resolve(bytes);
      })
      .resume();
  });
}

const LT = 0x3c;
const DTD_MARKERS = ['!DOCTYPE', '!ENTITY'].map((marker) => Array.from(marker, (char) => char.charCodeAt(0)));

const upper = (byte: number): number => (byte >= 0x61 && byte <= 0x7a ? byte - 0x20 : byte);

/** True when `marker` follows `<` at `start`, in 1-byte or UTF-16 (2-byte) form. */
function markerAt(bytes: Uint8Array, start: number, marker: number[], stride: 1 | 2): boolean {
  for (let index = 0; index < marker.length; index += 1) {
    const position = start + 1 + index * stride + (stride === 2 ? 1 : 0);
    if (position >= bytes.length || upper(bytes[position]) !== marker[index]) return false;
    if (stride === 2 && bytes[position - 1] !== 0) return false;
  }
  return true;
}

/**
 * True when the bytes contain a DTD or entity declaration in UTF-8/ASCII or
 * UTF-16 (either byte order). Office parts never need one, and internal
 * entities enable exponential "billion laughs" expansion in XML parsers.
 */
export function containsDtd(bytes: Uint8Array): boolean {
  for (let index = bytes.indexOf(LT); index !== -1; index = bytes.indexOf(LT, index + 1)) {
    for (const marker of DTD_MARKERS) {
      if (markerAt(bytes, index, marker, 1) || markerAt(bytes, index, marker, 2)) return true;
    }
  }
  return false;
}

/** Decodes XML part bytes honouring a UTF-16 byte-order mark (UTF-8 otherwise). */
function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

const DTD_TEXT = /<!(DOCTYPE|ENTITY)/i;

/**
 * Parses XML with the browser's DOMParser after refusing any DTD. DOMParser
 * never fetches external entities, so package XML cannot reach the network.
 */
export function parseXml(text: string): Document {
  if (DTD_TEXT.test(text)) throw new OfficeParseError('XML part declares a DTD');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new OfficeParseError('Malformed XML part');
  }
  return doc;
}

/**
 * A size-bounded view of an OOXML/ODF zip package. All reads share one budget
 * of inflated bytes, and every part is checked for DTDs before use.
 */
export class OfficePackage {
  private consumed = 0;
  /**
   * Reads are strictly sequential: the budget check happens before a read and
   * the bytes are counted after it, so overlapping reads could each pass the
   * check. A second read while one is in flight is refused.
   */
  private reading = false;

  private constructor(private readonly zip: JSZip, private readonly signal?: AbortSignal) {}

  /** Opens a package after checking its entry count and declared sizes. */
  static async open(data: Uint8Array | ArrayBuffer | Blob, signal?: AbortSignal): Promise<OfficePackage> {
    const zip = await JSZip.loadAsync(data);
    throwIfAborted(signal);
    const entries = Object.values(zip.files);
    if (entries.length > MAX_ZIP_ENTRIES) throw new OfficeParseError('Too many entries in package');
    // Cheap early reject; the streaming counter below is what actually binds.
    if (entries.reduce((total, entry) => total + declaredSize(entry), 0) > MAX_PACKAGE_BYTES) {
      throw new OfficeParseError('Package declares more than the preview limit');
    }
    return new OfficePackage(zip, signal);
  }

  /** File (non-directory) part paths in archive order. */
  paths(): string[] {
    return Object.values(this.zip.files).filter((entry) => !entry.dir).map((entry) => entry.name);
  }

  private entry(path: string): JSZip.JSZipObject | null {
    const entry = this.zip.file(path.replace(/^\//, ''));
    return entry && !entry.dir ? entry : null;
  }

  /** Inflated bytes of a part (null when absent), within the shared budget. */
  async readBytes(path: string): Promise<Uint8Array | null> {
    throwIfAborted(this.signal);
    const entry = this.entry(path);
    if (!entry) return null;
    if (this.reading) throw new OfficeParseError('Concurrent part reads are not supported');
    const remaining = MAX_PACKAGE_BYTES - this.consumed;
    if (declaredSize(entry) > Math.min(MAX_PART_BYTES, remaining)) {
      throw new OfficeParseError(`Part too large: ${path}`);
    }
    this.reading = true;
    let bytes: Uint8Array;
    try {
      bytes = await inflateBounded(entry, Math.min(MAX_PART_BYTES, remaining));
    } finally {
      this.reading = false;
    }
    throwIfAborted(this.signal);
    this.consumed += bytes.length;
    if (containsDtd(bytes)) throw new OfficeParseError(`Part declares a DTD: ${path}`);
    return bytes;
  }

  /** Reads a part as text; null when absent. */
  async readText(path: string): Promise<string | null> {
    const bytes = await this.readBytes(path);
    return bytes === null ? null : decodeText(bytes);
  }

  /** Reads and parses an XML part; null when absent. */
  async readXml(path: string): Promise<Document | null> {
    const text = await this.readText(path);
    return text === null ? null : parseXml(text);
  }

  /** Maps relationship ids to package paths from a `.rels` part (internal targets only). */
  async readRelationships(relsPath: string, baseDir: string): Promise<Map<string, string>> {
    const doc = await this.readXml(relsPath);
    const targets = new Map<string, string>();
    if (!doc) return targets;
    for (const rel of descendantsByName(doc, 'Relationship')) {
      const id = rel.getAttribute('Id');
      const target = rel.getAttribute('Target');
      if (!id || !target || rel.getAttribute('TargetMode') === 'External') continue;
      targets.set(id, resolvePartPath(baseDir, target));
    }
    return targets;
  }
}

/** Direct children of `parent` with the given local (namespace-free) name. */
export const childrenByName = (parent: Element, localName: string): Element[] =>
  Array.from(parent.children).filter((child) => child.localName === localName);

/** Descendants of `root` with the given local name, in document order. */
export const descendantsByName = (root: Document | Element, localName: string): Element[] =>
  Array.from(root.getElementsByTagNameNS('*', localName));

/**
 * Element descendants of `root` in document order, walked through sibling
 * links. Unlike live collections this is O(1) per step in every DOM
 * implementation and can stop early without materializing a huge list.
 */
export function* elementsInOrder(root: Document | Element): Generator<Element> {
  const top = root.nodeType === 9 ? (root as Document).documentElement : (root as Element);
  if (!top) return;
  if (root.nodeType === 9) yield top;
  let current: Element | null = top.firstElementChild;
  while (current) {
    yield current;
    if (current.firstElementChild) {
      current = current.firstElementChild;
      continue;
    }
    while (current && current !== top && !current.nextElementSibling) current = current.parentElement;
    current = current && current !== top ? current.nextElementSibling : null;
  }
}

/** Visits descendants with the given local name in document order; stops when `visit` returns false. */
export function forEachDescendant(root: Document | Element, localName: string, visit: (element: Element) => boolean): void {
  for (const element of elementsInOrder(root)) {
    if (element.localName === localName && !visit(element)) return;
  }
}

/** Attribute lookup by local name, ignoring the namespace prefix. */
export function attrByName(element: Element, localName: string): string | null {
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.localName === localName) return attribute.value;
  }
  return null;
}

// Transitional and Strict OOXML use different relationship namespaces.
const RELATIONSHIP_NAMESPACES = [
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
];

/** The `r:id` relationship reference of an element (not its plain `id`). */
export const relationshipId = (element: Element): string =>
  RELATIONSHIP_NAMESPACES.map((ns) => element.getAttributeNS(ns, 'id')).find(Boolean) ?? '';

/** Resolves a relationship target (relative or absolute) to a package path. */
export function resolvePartPath(baseDir: string, target: string): string {
  const segments = target.startsWith('/') ? [] : baseDir.split('/').filter(Boolean);
  for (const segment of target.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}
