/**
 * RUNNER: vitest (`npm run test:client`) — jsdom (DOMParser).
 * Bounded package reads (C3, C7): lying-size zip bombs stop at the cap,
 * a shared inflate budget, DTD/entity refusal, entry-count cap.
 */
import { createRequire } from 'node:module';

import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';

import { OfficeAbortError } from './cancellation';
import { deflatedZeros, lyingZip, openFiles, zipBytes } from './testing/officeFixtures';
import {
  MAX_PACKAGE_BYTES,
  MAX_PART_BYTES,
  MAX_ZIP_ENTRIES,
  OfficePackage,
  OfficeParseError,
  containsDtd,
  inflateBounded,
  parseXml,
  resolvePartPath,
} from './zipXml';

/** Counts bytes JSZip's inflater (pako) actually produced while `run` executes. */
async function countInflatedBytes(run: () => Promise<unknown>): Promise<number> {
  const pako = createRequire(import.meta.url)('pako') as { Inflate: { prototype: { push(...args: unknown[]): boolean } } };
  const proto = pako.Inflate.prototype;
  const original = proto.push;
  let inflated = 0;
  proto.push = function push(this: { strm: { total_out: number } }, ...args: unknown[]) {
    const before = this.strm.total_out;
    const result = original.apply(this, args);
    inflated += this.strm.total_out - before;
    return result;
  };
  try {
    await run();
  } finally {
    proto.push = original;
  }
  return inflated;
}

describe('C3: zip bomb with lying declared sizes', () => {
  it('rejects a 512 MiB part declared as 1 KB without inflating it', async () => {
    const bomb = lyingZip('xl/workbook.xml', await deflatedZeros(512 * 1024 * 1024), 1024);
    const pkg = await OfficePackage.open(bomb);
    const started = performance.now();
    const inflated = await countInflatedBytes(() =>
      expect(pkg.readBytes('xl/workbook.xml')).rejects.toBeInstanceOf(OfficeParseError));
    // The cap (16 MiB) stops inflation within one compressed chunk past it.
    expect(inflated).toBeLessThan(MAX_PART_BYTES + 17 * 1024 * 1024);
    expect(performance.now() - started).toBeLessThan(1500);
  }, 30_000);

  it('inflateBounded stops past the limit, and past a lying declared size', async () => {
    const honest = (await JSZip.loadAsync(await zipBytes({ 'a.xml': new Uint8Array(4 * 1024 * 1024) }))).file('a.xml');
    await expect(inflateBounded(honest!, 1024 * 1024)).rejects.toThrow(/preview limit/);
    expect((await inflateBounded(honest!, 4 * 1024 * 1024)).length).toBe(4 * 1024 * 1024);
    const lying = (await JSZip.loadAsync(lyingZip('a.xml', await deflatedZeros(4 * 1024 * 1024), 10))).file('a.xml');
    await expect(inflateBounded(lying!, 8 * 1024 * 1024)).rejects.toThrow(/declared size/);
  });

  it('aborts as soon as a part inflates past its own declared size, with our error', async () => {
    const bomb = lyingZip('a.xml', await deflatedZeros(64 * 1024 * 1024), 10);
    const pkg = await OfficePackage.open(bomb);
    let error: unknown;
    const inflated = await countInflatedBytes(() => pkg.readBytes('a.xml').catch((caught: unknown) => { error = caught; }));
    expect(error).toBeInstanceOf(OfficeParseError);
    expect(String(error)).toMatch(/declared size/);
    expect(inflated).toBeLessThan(17 * 1024 * 1024);
  });

  it('normalizes JSZip internal errors (size mismatch) to OfficeParseError', async () => {
    const short = lyingZip('a.xml', await deflatedZeros(1024 * 1024), 4 * 1024 * 1024);
    const pkg = await OfficePackage.open(short);
    await expect(pkg.readBytes('a.xml')).rejects.toBeInstanceOf(OfficeParseError);
  });

  it('refuses concurrent reads that could race the shared budget', async () => {
    const pkg = await openFiles({ 'a.xml': '<a/>', 'b.xml': '<b/>' });
    const first = pkg.readBytes('a.xml');
    await expect(pkg.readBytes('b.xml')).rejects.toBeInstanceOf(OfficeParseError);
    await expect(first).resolves.not.toBeNull();
  });

  it('rejects up front when declared sizes already exceed the package cap', async () => {
    const bomb = lyingZip('a.xml', await deflatedZeros(1024 * 1024), MAX_PACKAGE_BYTES + 1);
    await expect(OfficePackage.open(bomb)).rejects.toBeInstanceOf(OfficeParseError);
  });

  it('C7: shares one inflate budget across parts', async () => {
    expect(MAX_PART_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(MAX_PACKAGE_BYTES).toBeLessThanOrEqual(100 * 1024 * 1024);
    // Four 15 MiB parts fit; every read draws on the same budget, so a fifth read fails.
    const part = new Uint8Array(15 * 1024 * 1024);
    const pkg = await openFiles(Object.fromEntries(Array.from({ length: 4 }, (_, index) => [`p${index}.bin`, part])));
    for (let index = 0; index < 4; index += 1) await pkg.readBytes(`p${index}.bin`);
    await expect(pkg.readBytes('p0.bin')).rejects.toBeInstanceOf(OfficeParseError);
  }, 30_000);
});

describe('DTD and entity refusal', () => {
  const laughs = '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]><workbook>&b;</workbook>';

  it('refuses parts declaring a DTD in UTF-8, UTF-16LE and UTF-16BE', async () => {
    const utf16 = (text: string, littleEndian: boolean) => {
      const bytes = new Uint8Array(2 + text.length * 2);
      bytes.set(littleEndian ? [0xff, 0xfe] : [0xfe, 0xff]);
      for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        bytes[2 + index * 2 + (littleEndian ? 0 : 1)] = code;
      }
      return bytes;
    };
    const pkg = await openFiles({ a: laughs, b: utf16(laughs, true), c: utf16(laughs, false), d: '<x><!ENTITY y "z"></x>' });
    for (const path of ['a', 'b', 'c', 'd']) await expect(pkg.readXml(path)).rejects.toBeInstanceOf(OfficeParseError);
  });

  it('detects markers case-insensitively and ignores ordinary markup', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    expect(containsDtd(encode('<!doctype x>'))).toBe(true);
    expect(containsDtd(encode('<w:t>&lt;!DOCTYPE is text</w:t><a/><!-- c -->'))).toBe(false);
    expect(() => parseXml('<a><!ENTITY x "y"></a>')).toThrow(OfficeParseError);
  });

  it('decodes UTF-16 parts by byte-order mark', async () => {
    const text = '<a>نص</a>';
    const bytes = new Uint8Array(2 + text.length * 2);
    bytes.set([0xff, 0xfe]);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      bytes[2 + index * 2] = code & 0xff;
      bytes[3 + index * 2] = code >> 8;
    }
    const doc = await (await openFiles({ 'a.xml': bytes })).readXml('a.xml');
    expect(doc?.documentElement.textContent).toBe('نص');
  });
});

describe('OfficePackage basics', () => {
  it('rejects packages with too many entries', async () => {
    const files = Object.fromEntries(Array.from({ length: MAX_ZIP_ENTRIES + 1 }, (_, index) => [`f${index}`, '']));
    await expect(OfficePackage.open(await zipBytes(files))).rejects.toBeInstanceOf(OfficeParseError);
  });

  it('rejects data that is not a zip archive', async () => {
    await expect(OfficePackage.open(new TextEncoder().encode('not a zip'))).rejects.toBeTruthy();
  });

  it('returns null for absent parts and lists file paths only', async () => {
    const pkg = await openFiles({ 'dir/a.xml': '<a/>' });
    expect(await pkg.readBytes('missing.xml')).toBeNull();
    expect(await pkg.readXml('/dir/a.xml')).not.toBeNull();
    expect(pkg.paths()).toEqual(['dir/a.xml']);
  });

  it('stops reading once aborted', async () => {
    const controller = new AbortController();
    const pkg = await openFiles({ 'a.xml': '<a/>' }, controller.signal);
    controller.abort();
    await expect(pkg.readBytes('a.xml')).rejects.toBeInstanceOf(OfficeAbortError);
  });

  it('resolves relationship targets and skips external ones', async () => {
    expect(resolvePartPath('xl', '../docProps/app.xml')).toBe('docProps/app.xml');
    expect(resolvePartPath('xl', '/xl/worksheets/s.xml')).toBe('xl/worksheets/s.xml');
    const pkg = await openFiles({
      'x/_rels/a.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="r1" Target="b.xml"/><Relationship Id="r2" Target="https://evil.test" TargetMode="External"/></Relationships>',
    });
    const rels = await pkg.readRelationships('x/_rels/a.rels', 'x');
    expect([...rels]).toEqual([['r1', 'x/b.xml']]);
  });
});
