/**
 * RUNNER: vitest (`npm run test:client`) — jsdom (DOMParser).
 * Spreadsheet, presentation and OpenDocument parsers: content, RTL, caps on
 * hostile merges/repeats (C4), cancellation, and a real openpyxl workbook.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { OfficeAbortError } from './cancellation';
import { parseOfficeFile } from './parseOfficeFile';
import { MAX_TEXT_BLOCKS, odfParagraphText, parseOdp, parseOdt } from './parseOdf';
import { parseOds } from './parseOds';
import { parsePptx } from './parsePptx';
import { MAX_SLIDES } from './previewModel';
import { formatDateSerial, isDateFormatCode, parseXlsx } from './parseXlsx';
import { CellBudget, GridBuilder, MAX_COLUMNS, MAX_MERGES, MAX_ROWS, columnLabel, parseCellRef } from './sheetGrid';
import { openFiles, zipBytes } from './testing/officeFixtures';
import { OfficeParseError, parseXml } from './zipXml';

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const xlsxFiles = (sheetXml: string, extra: Record<string, string> = {}) => ({
  'xl/workbook.xml': `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr/><sheets>
    <sheet name="ملخص" sheetId="7" r:id="rId1"/>
    <sheet name="Hidden" sheetId="8" state="hidden" r:id="rId2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${PKG_REL}">
    <Relationship Id="rId1" Target="worksheets/sheet1.xml"/>
    <Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  'xl/worksheets/sheet1.xml': sheetXml,
  'xl/worksheets/sheet2.xml': `<worksheet xmlns="${MAIN}"><sheetData/></worksheet>`,
  ...extra,
});

const sheet = (inner: string) => `<worksheet xmlns="${MAIN}">${inner}</worksheet>`;

describe('parseXlsx', () => {
  it('reads shared/inline strings, numbers, booleans, dates, merges and RTL', async () => {
    const pkg = await openFiles(xlsxFiles(
      sheet(`<sheetViews><sheetView rightToLeft="1"/></sheetViews><sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>inline</t></is></c></row>
        <row r="3"><c r="A3"><v>0.30000000000000004</v></c><c r="B3" t="b"><v>1</v></c><c r="C3" s="1"><v>45580</v></c></row>
      </sheetData><mergeCells><mergeCell ref="A1:B1"/></mergeCells>`),
      {
        'xl/sharedStrings.xml': `<sst xmlns="${MAIN}"><si><r><t>مرحبا </t></r><r><t>بالعالم</t></r><rPh><t>x</t></rPh></si></sst>`,
        'xl/styles.xml': `<styleSheet xmlns="${MAIN}"><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
      },
    ));
    const { sheets } = await parseXlsx(pkg);
    expect(sheets).toHaveLength(1); // hidden sheet skipped
    const [first] = sheets;
    expect(first.name).toBe('ملخص');
    expect(first.rtl).toBe(true);
    expect(first.columnCount).toBe(3);
    expect(first.rows[0][0]).toMatchObject({ text: 'مرحبا بالعالم', colSpan: 2, rowSpan: 1 });
    expect(first.rows[0][1]?.covered).toBe(true);
    expect(first.rows[0][2]?.text).toBe('inline');
    expect(first.rows[1].every((cell) => cell === undefined)).toBe(true);
    expect(first.rows[2].map((cell) => cell?.text)).toEqual(['0.3', 'TRUE', '2024-10-15']);
  });

  it('stops the row loop at the preview limit and flags truncation', async () => {
    const rows = `<row r="1"><c r="A1"><v>1</v></c></row><row r="${MAX_ROWS + 5}"><c r="A${MAX_ROWS + 5}"><v>2</v></c></row>`;
    const { sheets } = await parseXlsx(await openFiles(xlsxFiles(sheet(`<sheetData>${rows}</sheetData>`))));
    expect(sheets[0].truncated).toBe(true);
    expect(sheets[0].rows).toHaveLength(1);
  });

  it('flags cells past the column limit', async () => {
    const xml = sheet(`<sheetData><row r="1"><c r="A1"><v>1</v></c><c r="DA1"><v>2</v></c></row></sheetData>`);
    const { sheets } = await parseXlsx(await openFiles(xlsxFiles(xml)));
    expect(sheets[0].truncated).toBe(true);
    expect(sheets[0].columnCount).toBe(1);
  });

  it('C4: 100k hostile merges parse in bounded time and stay capped', async () => {
    const merges = Array.from({ length: 100_000 }, () => '<mergeCell ref="A1:CV1000"/>').join('');
    const xml = sheet(`<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData><mergeCells>${merges}</mergeCells>`);
    const pkg = await openFiles(xlsxFiles(xml));
    const started = performance.now();
    const { sheets } = await parseXlsx(pkg);
    const elapsed = performance.now() - started;
    expect(sheets[0].truncated).toBe(true);
    expect(sheets[0].rows[0][0]).toMatchObject({ rowSpan: MAX_ROWS, colSpan: MAX_COLUMNS });
    // Dominated by jsdom parsing ~3 MB of XML (browsers parse it far faster);
    // the merge work itself is bounded by the GridBuilder test below (<500 ms).
    expect(elapsed).toBeLessThan(15_000);
  }, 30_000);

  it('rejects a package without a workbook, malformed XML and DTDs', async () => {
    await expect(parseXlsx(await openFiles({ 'other.xml': '<x/>' }))).rejects.toBeInstanceOf(OfficeParseError);
    await expect(parseXlsx(await openFiles(xlsxFiles('<worksheet><sheetData>')))).rejects.toBeInstanceOf(OfficeParseError);
    const dtd = '<!DOCTYPE w [<!ENTITY a "x">]><worksheet xmlns="' + MAIN + '"><sheetData/></worksheet>';
    await expect(parseXlsx(await openFiles(xlsxFiles(dtd)))).rejects.toBeInstanceOf(OfficeParseError);
  });

  it('shares one cell budget across sheets', async () => {
    const budget = new CellBudget(3);
    const grid = new GridBuilder(budget);
    for (let col = 0; col < 5; col += 1) grid.set(0, col, { text: 'x', numeric: false });
    expect(grid.build('s', false).columnCount).toBe(3);
    expect(grid.truncated).toBe(true);
  });

  // The binary Office fixtures stay out of the public export (its leak gate cannot
  // scan ZIP containers), so the case skips only where the file is absent.
  const arabicXlsx = join(dirname(fileURLToPath(import.meta.url)), 'testing/fixtures/arabic-rtl.xlsx');
  it.skipIf(!existsSync(arabicXlsx))('parses a real openpyxl workbook with an Arabic right-to-left sheet', async () => {
    const result = await parseOfficeFile('xlsx', new Uint8Array(readFileSync(arabicXlsx)));
    expect(result.kind).toBe('spreadsheet');
    if (result.kind !== 'spreadsheet') return;
    const [budget, notes] = result.workbook.sheets;
    expect(budget.name).toBe('الميزانية');
    expect(budget.rtl).toBe(true);
    expect(budget.rows[0][0]).toMatchObject({ text: 'ميزانية الربع الأول', colSpan: 3 });
    expect(budget.rows[2].map((cell) => cell?.text)).toEqual(['رواتب', '12500.5', '2026-01-31']);
    expect(budget.rows[4][0]?.text).toBe('الإجمالي');
    expect(notes).toMatchObject({ name: 'Notes', rtl: false });
    expect(notes.rows[1][1]?.text).toBe('TRUE');
  });
});

describe('GridBuilder merge caps (C4)', () => {
  it('handles 100k merges in under 500 ms', () => {
    const grid = new GridBuilder();
    const started = performance.now();
    for (let index = 0; index < 100_000; index += 1) grid.merge(0, 0, 1_000_000, 16_000);
    for (let index = 0; index < 100_000; index += 1) grid.merge(index % MAX_ROWS, index % MAX_COLUMNS, index % MAX_ROWS + 1, index % MAX_COLUMNS + 1);
    expect(performance.now() - started).toBeLessThan(500);
    expect(grid.truncated).toBe(true);
  });

  it('ignores merges that start outside the preview and caps their count', () => {
    const grid = new GridBuilder();
    grid.merge(MAX_ROWS, 0, MAX_ROWS + 5, 2);
    grid.merge(0, MAX_COLUMNS, 3, MAX_COLUMNS + 3);
    expect(grid.build('s', false).rows).toHaveLength(0);
    for (let index = 0; index <= MAX_MERGES; index += 1) grid.merge(index % 500, 0, index % 500, 1);
    expect(grid.truncated).toBe(true);
  });
});

describe('date and reference helpers', () => {
  it('detects date format codes but not quoted or bracketed text', () => {
    expect(isDateFormatCode('dd/mm/yyyy')).toBe(true);
    expect(isDateFormatCode('[h]:mm')).toBe(true);
    expect(isDateFormatCode('#,##0.00 "SAR"')).toBe(false);
    expect(isDateFormatCode('[Red]0.00')).toBe(false);
  });

  it('formats 1900 and 1904 serials, times and date-times', () => {
    expect(formatDateSerial(45580, false)).toBe('2024-10-15');
    expect(formatDateSerial(0, true)).toBe('00:00:00');
    expect(formatDateSerial(1, true)).toBe('1904-01-02');
    expect(formatDateSerial(0.5, false)).toBe('12:00:00');
    expect(formatDateSerial(45580.25, false)).toBe('2024-10-15 06:00');
  });

  it('converts cell references and column labels', () => {
    expect(parseCellRef('$AB$12')).toEqual({ row: 11, col: 27 });
    expect(parseCellRef('nope')).toBeNull();
    expect(columnLabel(0)).toBe('A');
    expect(columnLabel(27)).toBe('AB');
  });
});

const ODF = 'urn:oasis:names:tc:opendocument:xmlns';
const ODF_ROOT = `xmlns:office="${ODF}:office:1.0" xmlns:table="${ODF}:table:1.0" xmlns:text="${ODF}:text:1.0" `
  + `xmlns:style="${ODF}:style:1.0" xmlns:draw="${ODF}:drawing:1.0" xmlns:presentation="${ODF}:presentation:1.0"`;
const odfContent = (body: string, styles = '') =>
  `<office:document-content ${ODF_ROOT}><office:automatic-styles>${styles}</office:automatic-styles><office:body>${body}</office:body></office:document-content>`;

describe('parseOds', () => {
  it('expands repeats, skips huge empty padding, reads spans and RTL tables', async () => {
    const pkg = await openFiles({
      'content.xml': odfContent(`<office:spreadsheet><table:table table:name="بيانات" table:style-name="ta1">
          <table:table-header-rows><table:table-row>
            <table:table-cell table:number-columns-spanned="2"><text:p>Title</text:p></table:table-cell><table:covered-table-cell/>
          </table:table-row></table:table-header-rows>
          <table:table-row-group><table:table-row table:number-rows-repeated="2">
            <table:table-cell office:value-type="float"><text:p>5</text:p></table:table-cell>
            <table:table-cell table:number-columns-repeated="16000"/>
          </table:table-row></table:table-row-group>
          <table:table-row table:number-rows-repeated="1048000"><table:table-cell/></table:table-row>
        </table:table><table:table table:name="LTR" table:style-name="ta2"/></office:spreadsheet>`,
      '<style:style style:name="ta1" style:family="table"><style:table-properties table:display="true" style:writing-mode="rl-tb"/></style:style>'
      + '<style:style style:name="ta2" style:family="table"><style:table-properties table:display="true" style:writing-mode="lr-tb"/></style:style>'),
    });
    const { sheets } = await parseOds(pkg);
    const [first, second] = sheets;
    expect(first).toMatchObject({ name: 'بيانات', rtl: true, truncated: false });
    expect(first.rows).toHaveLength(3);
    expect(first.rows[0][0]).toMatchObject({ text: 'Title', colSpan: 2 });
    expect(first.rows[2][0]).toMatchObject({ text: '5', numeric: true });
    expect(second.rtl).toBe(false);
  });

  it('C4: caps repeated content rows, columns and spans', async () => {
    const pkg = await openFiles({
      'content.xml': odfContent(`<office:spreadsheet><table:table table:name="Big">
          <table:table-row table:number-rows-repeated="1000000">
            <table:table-cell table:number-columns-repeated="16384" table:number-rows-spanned="1000000"><text:p>x</text:p></table:table-cell>
          </table:table-row></table:table></office:spreadsheet>`),
    });
    const started = performance.now();
    const { sheets } = await parseOds(pkg);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(sheets[0].truncated).toBe(true);
    expect(sheets[0].rows.length).toBeLessThanOrEqual(MAX_ROWS);
    expect(sheets[0].columnCount).toBeLessThanOrEqual(MAX_COLUMNS);
  });

  it('rejects a package without a spreadsheet body', async () => {
    await expect(parseOds(await openFiles({ 'content.xml': '<doc/>' }))).rejects.toBeInstanceOf(OfficeParseError);
  });
});

const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const slideXml = (texts: string[]) => `<p:sld xmlns:p="${PML}" xmlns:a="${DML}"><p:cSld><p:spTree><p:sp><p:txBody>
  ${texts.map((text) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`).join('')}<a:p/></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

describe('parsePptx', () => {
  it('lists slide text in presentation order using r:id, not the numeric id', async () => {
    const pkg = await openFiles({
      'ppt/presentation.xml': `<p:presentation xmlns:p="${PML}" xmlns:r="${REL}"><p:sldIdLst>
        <p:sldId id="256" r:id="rId9"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${PKG_REL}">
        <Relationship Id="rId3" Target="slides/slide1.xml"/><Relationship Id="rId9" Target="slides/slide2.xml"/></Relationships>`,
      'ppt/slides/slide1.xml': slideXml(['Second']),
      'ppt/slides/slide2.xml': slideXml(['العنوان', 'نقطة']),
      'ppt/vbaProject.bin': 'macro bytes that are never read',
    });
    const { slides, truncated } = await parsePptx(pkg);
    expect(truncated).toBe(false);
    expect(slides).toEqual([
      { number: 1, paragraphs: ['العنوان', 'نقطة'] },
      { number: 2, paragraphs: ['Second'] },
    ]);
  });

  it('accepts a template with no slides and flags too many slides', async () => {
    const empty = await parsePptx(await openFiles({ 'ppt/presentation.xml': `<p:presentation xmlns:p="${PML}"/>` }));
    expect(empty).toEqual({ slides: [], truncated: false });
    const ids = Array.from({ length: MAX_SLIDES + 1 }, (_, index) => `<p:sldId id="${index}" r:id="x"/>`).join('');
    const many = await parsePptx(await openFiles({ 'ppt/presentation.xml': `<p:presentation xmlns:p="${PML}" xmlns:r="${REL}"><p:sldIdLst>${ids}</p:sldIdLst></p:presentation>` }));
    expect(many.truncated).toBe(true);
  });
});

describe('OpenDocument text and presentations', () => {
  it('extracts ODT headings and paragraphs, expanding spaces and skipping notes', async () => {
    const pkg = await openFiles({
      'content.xml': odfContent(`<office:text>
        <text:h text:outline-level="2">سياسة <text:span>التشغيل</text:span></text:h>
        <text:p>a<text:s text:c="3"/>b<text:tab/>c<text:line-break/>d<text:note><text:note-body><text:p>footnote</text:p></text:note-body></text:note></text:p>
        <text:list><text:list-item><text:p>item</text:p></text:list-item></text:list>
        <text:p/></office:text>`),
    });
    expect(await parseOdt(pkg)).toEqual({
      blocks: [
        { text: 'سياسة التشغيل', heading: 2 },
        { text: 'a   b\tc\nd', heading: null },
        { text: 'item', heading: null },
      ],
      truncated: false,
    });
  });

  it('caps very long ODT documents', async () => {
    const paragraphs = '<text:p>x</text:p>'.repeat(MAX_TEXT_BLOCKS + 10);
    const result = await parseOdt(await openFiles({ 'content.xml': odfContent(`<office:text>${paragraphs}</office:text>`) }));
    expect(result.blocks).toHaveLength(MAX_TEXT_BLOCKS);
    expect(result.truncated).toBe(true);
  });

  it('extracts ODP text per page and skips speaker notes', async () => {
    const pkg = await openFiles({
      'content.xml': odfContent(`<office:presentation>
        <draw:page draw:name="p1"><draw:frame><draw:text-box><text:p>عنوان</text:p></draw:text-box></draw:frame>
          <presentation:notes><draw:frame><draw:text-box><text:p>speaker</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>
        <draw:page draw:name="p2"/></office:presentation>`),
    });
    expect(await parseOdp(pkg)).toEqual({ slides: [{ number: 1, paragraphs: ['عنوان'] }, { number: 2, paragraphs: [] }], truncated: false });
  });

  it('caps space runs from text:s', () => {
    const doc = parseXml(`<text:p xmlns:text="${ODF}:text:1.0">a<text:s text:c="999999"/>b</text:p>`);
    expect(odfParagraphText(doc.documentElement)).toHaveLength(102);
  });

  it('rejects ODF packages without the expected body', async () => {
    await expect(parseOdt(await openFiles({ 'content.xml': odfContent('<office:spreadsheet/>') }))).rejects.toBeInstanceOf(OfficeParseError);
  });
});

describe('parseOfficeFile', () => {
  it('routes formats and stops when cancelled', async () => {
    const bytes = await zipBytes({ 'content.xml': odfContent('<office:text><text:p>x</text:p></office:text>') });
    expect((await parseOfficeFile('odt', bytes)).kind).toBe('text');
    const ods = await zipBytes({ 'content.xml': odfContent('<office:spreadsheet><table:table table:name="S"/></office:spreadsheet>') });
    expect((await parseOfficeFile('ods', ods)).kind).toBe('spreadsheet');
    const odp = await zipBytes({ 'content.xml': odfContent('<office:presentation><draw:page/></office:presentation>') });
    expect((await parseOfficeFile('odp', odp)).kind).toBe('slides');
    const pptx = await zipBytes({ 'ppt/presentation.xml': `<p:presentation xmlns:p="${PML}"/>` });
    expect((await parseOfficeFile('pptx', pptx)).kind).toBe('slides');
    const controller = new AbortController();
    controller.abort();
    await expect(parseOfficeFile('odt', bytes, controller.signal)).rejects.toBeInstanceOf(OfficeAbortError);
  });
});
