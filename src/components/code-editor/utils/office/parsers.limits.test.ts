/**
 * RUNNER: vitest (`npm run test:client`) — jsdom (DOMParser).
 * M1: per-cell text cap, ODS rows computed once per repeat group, junk
 * siblings bounded, and cancellation inside long sheet loops.
 */
import { describe, expect, it } from 'vitest';

import { OfficeAbortError } from './cancellation';
import { parseOds } from './parseOds';
import { parsePptx } from './parsePptx';
import { parseXlsx } from './parseXlsx';
import { MAX_TEXT_CHARS } from './previewModel';
import { GridBuilder, MAX_CELL_CHARS } from './sheetGrid';
import { openFiles } from './testing/officeFixtures';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const ODF = 'urn:oasis:names:tc:opendocument:xmlns';

const xlsx = (sheetData: string, extra: Record<string, string> = {}) => ({
  'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG_REL}"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/worksheets/sheet1.xml': `<worksheet xmlns="${MAIN}"><sheetData>${sheetData}</sheetData></worksheet>`,
  ...extra,
});

const ods = (tableBody: string) => ({
  'content.xml': `<office:document-content xmlns:office="${ODF}:office:1.0" xmlns:table="${ODF}:table:1.0" xmlns:text="${ODF}:text:1.0">`
    + `<office:body><office:spreadsheet><table:table table:name="T">${tableBody}</table:table></office:spreadsheet></office:body></office:document-content>`,
});

describe('M1: cell text cap', () => {
  it(`GridBuilder clips cell text to ${MAX_CELL_CHARS} characters and flags truncation`, () => {
    expect(MAX_CELL_CHARS).toBe(32_767);
    const grid = new GridBuilder();
    grid.set(0, 0, { text: 'x'.repeat(MAX_CELL_CHARS + 10), numeric: false });
    const sheet = grid.build('s', false);
    expect(sheet.rows[0][0]?.text).toHaveLength(MAX_CELL_CHARS);
    expect(sheet.truncated).toBe(true);
  });

  it('caps an oversized XLSX shared string', async () => {
    const pkg = await openFiles(xlsx('<row r="1"><c r="A1" t="s"><v>0</v></c></row>', {
      'xl/sharedStrings.xml': `<sst xmlns="${MAIN}"><si><t>${'ب'.repeat(100_000)}</t></si></sst>`,
    }));
    const { sheets } = await parseXlsx(pkg);
    expect(sheets[0].rows[0][0]?.text).toHaveLength(MAX_CELL_CHARS);
    expect(sheets[0].truncated).toBe(true);
  });

  it('caps an oversized ODS cell', async () => {
    const pkg = await openFiles(ods(`<table:table-row><table:table-cell><text:p>${'x'.repeat(50_000)}</text:p></table:table-cell></table:table-row>`));
    const { sheets } = await parseOds(pkg);
    expect(sheets[0].rows[0][0]?.text).toHaveLength(MAX_CELL_CHARS);
    expect(sheets[0].truncated).toBe(true);
  });
});

describe('M1: ODS repeat and junk-sibling work is bounded', () => {
  it('a content row with 100k junk siblings repeated 1000 times parses quickly', async () => {
    const junk = '<table:junk/>'.repeat(100_000);
    const pkg = await openFiles(ods(`<table:table-row table:number-rows-repeated="1000">${junk}<table:table-cell><text:p>v</text:p></table:table-cell>${junk}</table:table-row>`));
    const started = performance.now();
    const { sheets } = await parseOds(pkg);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(sheets[0].truncated).toBe(true); // junk past the sibling cap
  }, 30_000);

  it('a large repeated text cell is read once, not once per repeat', async () => {
    const big = 'y'.repeat(20_000);
    const pkg = await openFiles(ods(`<table:table-row table:number-rows-repeated="1000"><table:table-cell table:number-columns-repeated="100"><text:p>${big}</text:p></table:table-cell></table:table-row>`));
    const started = performance.now();
    const { sheets } = await parseOds(pkg);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(sheets[0].rows[999][99]?.text).toHaveLength(20_000);
  }, 30_000);
});

describe('M1: cancellation inside long sheets', () => {
  const rows = (count: number, cell: (index: number) => string) => Array.from({ length: count }, (_, index) => cell(index)).join('');

  it('parseOds stops mid-table when aborted', async () => {
    const pkg = await openFiles(ods(rows(1000, (i) => `<table:table-row>${'<table:table-cell><text:p>v</text:p></table:table-cell>'.repeat(50)}${i}</table:table-row>`)));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    await expect(parseOds(pkg, controller.signal)).rejects.toBeInstanceOf(OfficeAbortError);
  }, 30_000);

  it('parseXlsx stops mid-sheet when aborted', async () => {
    const pkg = await openFiles(xlsx(rows(1000, (i) => `<row r="${i + 1}">${rows(50, (c) => `<c r="${String.fromCharCode(65 + (c % 26))}${String.fromCharCode(65 + Math.floor(c / 26))}${i + 1}"><v>${c}</v></c>`)}</row>`)));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 0);
    await expect(parseXlsx(pkg, controller.signal)).rejects.toBeInstanceOf(OfficeAbortError);
  }, 30_000);
});

describe('presentation text cap', () => {
  it('stops collecting slides past MAX_TEXT_CHARS and flags truncation', async () => {
    const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
    const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
    const slide = `<p:sld xmlns:p="${PML}" xmlns:a="${DML}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${'z'.repeat(MAX_TEXT_CHARS * 0.6)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
    const pkg = await openFiles({
      'ppt/presentation.xml': `<p:presentation xmlns:p="${PML}" xmlns:r="${REL}"><p:sldIdLst><p:sldId id="1" r:id="r1"/><p:sldId id="2" r:id="r2"/><p:sldId id="3" r:id="r3"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${PKG_REL}"><Relationship Id="r1" Target="slides/s.xml"/><Relationship Id="r2" Target="slides/s.xml"/><Relationship Id="r3" Target="slides/s.xml"/></Relationships>`,
      'ppt/slides/s.xml': slide,
    });
    const result = await parsePptx(pkg);
    expect(result.slides).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
