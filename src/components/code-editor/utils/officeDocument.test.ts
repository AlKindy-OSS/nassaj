/**
 * RUNNER: vitest (`npm run test:client`).
 * Routing: which file extensions reach which office parser, and legacy formats.
 */
import { describe, expect, it } from 'vitest';

import { isBinaryFile } from './binaryFile';
import { getOfficeFormat, isLegacyOfficeFile } from './officeDocument';
import { getPreviewKind } from './previewableFile';

describe('getOfficeFormat', () => {
  it.each([
    ['report.docx', 'docx'],
    ['internal-operations-policy-2026-10-15.ar.docx', 'docx'],
    ['macro.docm', 'docx'],
    ['letter.dotx', 'docx'],
    ['Budget.XLSX', 'xlsx'],
    ['macro.xlsm', 'xlsx'],
    ['template.xltx', 'xlsx'],
    ['data.ods', 'ods'],
    ['deck.pptx', 'pptx'],
    ['macro.pptm', 'pptx'],
    ['show.ppsx', 'pptx'],
    ['theme.potx', 'pptx'],
    ['notes.odt', 'odt'],
    ['slides.odp', 'odp'],
  ])('routes %s to the %s parser', (name, format) => {
    expect(getOfficeFormat(name)).toBe(format);
  });

  it.each(['legacy.doc', 'legacy.xls', 'legacy.ppt', 'docx', '.docx', 'archive.zip', 'readme.md', 'macro.dotm'])(
    'keeps %s off the office preview',
    (name) => {
      expect(getOfficeFormat(name)).toBeNull();
    },
  );

  it('never overlaps the native media preview and is never read as text', () => {
    for (const name of ['a.docx', 'a.docm', 'a.dotx', 'a.xlsx', 'a.xlsm', 'a.xltx', 'a.ods', 'a.pptx', 'a.pptm', 'a.ppsx', 'a.potx', 'a.odt', 'a.odp']) {
      expect(getPreviewKind(name)).toBeNull();
      expect(isBinaryFile(name)).toBe(true);
    }
  });
});

describe('isLegacyOfficeFile', () => {
  it('flags doc/xls/ppt only', () => {
    expect(['a.doc', 'B.XLS', 'c.ppt'].map(isLegacyOfficeFile)).toEqual([true, true, true]);
    expect(['a.docx', 'doc', 'a.txt'].map(isLegacyOfficeFile)).toEqual([false, false, false]);
  });
});
