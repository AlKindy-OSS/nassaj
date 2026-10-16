import type { OfficeFormat } from '../officeDocument';

import { throwIfAborted } from './cancellation';
import { parseOdp, parseOdt } from './parseOdf';
import { parseOds } from './parseOds';
import { parsePptx } from './parsePptx';
import { parseXlsx } from './parseXlsx';
import type { PresentationData, TextDocumentData } from './previewModel';
import type { SanitizedDocument } from './previewSrcdoc';
import type { WorkbookData } from './sheetGrid';
import { OfficePackage } from './zipXml';

export type OfficePreviewResult =
  | { kind: 'document'; document: SanitizedDocument }
  | { kind: 'spreadsheet'; workbook: WorkbookData }
  | { kind: 'slides'; presentation: PresentationData }
  | { kind: 'text'; text: TextDocumentData };

/**
 * Parses office file bytes into a read-only preview model. Throws on any
 * malformed, oversized or cancelled package; callers fall back to the
 * download screen.
 */
export async function parseOfficeFile(format: OfficeFormat, data: Uint8Array, signal?: AbortSignal): Promise<OfficePreviewResult> {
  const pkg = await OfficePackage.open(data, signal);
  let result: OfficePreviewResult;
  switch (format) {
    case 'docx': {
      // docx-preview is the heaviest dependency; keep it in its own lazy chunk.
      const { renderDocx } = await import('./renderDocx');
      result = { kind: 'document', document: await renderDocx(pkg, signal) };
      break;
    }
    case 'xlsx':
      result = { kind: 'spreadsheet', workbook: await parseXlsx(pkg, signal) };
      break;
    case 'ods':
      result = { kind: 'spreadsheet', workbook: await parseOds(pkg, signal) };
      break;
    case 'pptx':
      result = { kind: 'slides', presentation: await parsePptx(pkg, signal) };
      break;
    case 'odp':
      result = { kind: 'slides', presentation: await parseOdp(pkg, signal) };
      break;
    default:
      result = { kind: 'text', text: await parseOdt(pkg) };
  }
  throwIfAborted(signal);
  return result;
}
