import { createCheckpoint } from './cancellation';
import { MAX_SLIDES, MAX_TEXT_CHARS, type PresentationData, type SlideText, type TextBlock, type TextDocumentData } from './previewModel';
import { OfficeParseError, attrByName, descendantsByName, elementsInOrder, type OfficePackage } from './zipXml';

// OpenDocument text (.odt) and presentation (.odp) previews are text only:
// paragraphs and headings in reading order, no layout or images.

export const MAX_TEXT_BLOCKS = 5000;
const MAX_SPACE_RUN = 100;


// Content that is not part of the main reading flow (or is nested text whose
// paragraphs are collected on their own).
const SKIPPED_INLINE = new Set(['note', 'annotation', 'frame', 'tracked-changes', 'ruby-text']);
const SKIPPED_CONTAINERS = new Set(['note', 'annotation', 'tracked-changes', 'notes']);

/** The visible text of an ODF paragraph, expanding spaces, tabs and breaks. */
export function odfParagraphText(paragraph: Element): string {
  let text = '';
  const walk = (node: Node): void => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) {
        text += child.nodeValue ?? '';
        continue;
      }
      if (child.nodeType !== 1) continue;
      const element = child as Element;
      if (element.localName === 's') {
        const count = Number(attrByName(element, 'c') ?? 1);
        text += ' '.repeat(Number.isInteger(count) && count > 0 ? Math.min(count, MAX_SPACE_RUN) : 1);
      } else if (element.localName === 'tab') {
        text += '\t';
      } else if (element.localName === 'line-break') {
        text += '\n';
      } else if (!SKIPPED_INLINE.has(element.localName)) {
        walk(element);
      }
    }
  };
  walk(paragraph);
  return text;
}

/** True when the element sits inside notes, annotations or tracked changes. */
function isOutOfFlow(element: Element, root: Element): boolean {
  for (let parent = element.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (SKIPPED_CONTAINERS.has(parent.localName)) return true;
  }
  return false;
}

/** Paragraphs and headings under `root`, in document order. */
function textBlocks(root: Element): TextBlock[] {
  const blocks: TextBlock[] = [];
  for (const element of elementsInOrder(root)) {
    if (blocks.length > MAX_TEXT_BLOCKS) break;
    if ((element.localName !== 'p' && element.localName !== 'h') || isOutOfFlow(element, root)) continue;
    const text = odfParagraphText(element).trim();
    if (text === '') continue;
    const level = Number(attrByName(element, 'outline-level') ?? 1);
    blocks.push({ text, heading: element.localName === 'h' ? Math.min(Math.max(level || 1, 1), 6) : null });
  }
  return blocks;
}

const OFFICE_NS = 'urn:oasis:names:tc:opendocument:xmlns:office:1.0';

async function readBody(pkg: OfficePackage, bodyName: 'text' | 'presentation'): Promise<Element> {
  const content = await pkg.readXml('content.xml');
  const body = content?.getElementsByTagNameNS(OFFICE_NS, bodyName)[0];
  if (!body) throw new OfficeParseError(`Missing office:${bodyName} body`);
  return body;
}

/** Extracts paragraphs and headings from an ODT package. */
export async function parseOdt(pkg: OfficePackage): Promise<TextDocumentData> {
  const blocks = textBlocks(await readBody(pkg, 'text'));
  let chars = 0;
  const kept: TextBlock[] = [];
  for (const block of blocks.slice(0, MAX_TEXT_BLOCKS)) {
    chars += block.text.length;
    if (chars > MAX_TEXT_CHARS) break;
    kept.push(block);
  }
  return { blocks: kept, truncated: kept.length < blocks.length };
}

/** Extracts plain text per slide (draw:page) from an ODP package; speaker notes are skipped. */
export async function parseOdp(pkg: OfficePackage, signal?: AbortSignal): Promise<PresentationData> {
  const checkpoint = createCheckpoint(signal);
  const pages = descendantsByName(await readBody(pkg, 'presentation'), 'page');
  const slides: SlideText[] = [];
  for (const [index, page] of pages.slice(0, MAX_SLIDES).entries()) {
    await checkpoint();
    slides.push({ number: index + 1, paragraphs: textBlocks(page).map((block) => block.text) });
  }
  return { slides, truncated: pages.length > MAX_SLIDES };
}
