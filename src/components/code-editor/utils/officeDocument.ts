// Office documents can't be edited as text, but their content can be shown as a
// read-only preview: Word → rendered document, spreadsheets → table with sheet
// tabs, presentations and OpenDocument text → text only. Macro-enabled and
// template variants use the same parsers; macros are never executed. Legacy
// binary formats (doc, xls, ppt) keep the download screen with an explanation.

/** The parser a file is routed to. */
export type OfficeFormat = 'docx' | 'xlsx' | 'ods' | 'pptx' | 'odt' | 'odp';

const EXTENSION_FORMAT: Record<string, OfficeFormat> = {
  docx: 'docx',
  docm: 'docx',
  dotx: 'docx',
  xlsx: 'xlsx',
  xlsm: 'xlsx',
  xltx: 'xlsx',
  ods: 'ods',
  pptx: 'pptx',
  pptm: 'pptx',
  ppsx: 'pptx',
  potx: 'pptx',
  odt: 'odt',
  odp: 'odp',
};

const LEGACY_EXTENSIONS = new Set(['doc', 'xls', 'ppt']);

/** Files above this size skip parsing and show the download fallback. */
export const OFFICE_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;

const extensionOf = (filename: string): string | null => {
  const dot = filename.lastIndexOf('.');
  // A bare name such as "docx" has no extension at all.
  return dot <= 0 ? null : filename.slice(dot + 1).toLowerCase();
};

/** Returns the preview format for an office file name, or null when unsupported. */
export const getOfficeFormat = (filename: string): OfficeFormat | null => {
  const extension = extensionOf(filename);
  return extension ? EXTENSION_FORMAT[extension] ?? null : null;
};

/** True for legacy binary Office files (doc/xls/ppt), which are download-only. */
export const isLegacyOfficeFile = (filename: string): boolean => {
  const extension = extensionOf(filename);
  return extension !== null && LEGACY_EXTENSIONS.has(extension);
};
