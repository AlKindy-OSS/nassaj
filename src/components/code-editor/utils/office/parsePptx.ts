import { createCheckpoint } from './cancellation';
import { MAX_SLIDES, MAX_TEXT_CHARS, type PresentationData, type SlideText } from './previewModel';
import { OfficeParseError, descendantsByName, relationshipId, type OfficePackage } from './zipXml';

/** Text paragraphs of one slide part, in reading order, empty ones dropped. */
export function slideParagraphs(doc: Document): string[] {
  return descendantsByName(doc, 'p')
    .filter((p) => p.namespaceURI?.includes('drawingml'))
    .map((p) => descendantsByName(p, 't').map((t) => t.textContent ?? '').join('').trim())
    .filter((text) => text !== '');
}

/** Extracts plain text per slide from a PPTX-family package (pptx/pptm/ppsx/potx). */
export async function parsePptx(pkg: OfficePackage, signal?: AbortSignal): Promise<PresentationData> {
  const checkpoint = createCheckpoint(signal);
  const presentation = await pkg.readXml('ppt/presentation.xml');
  if (!presentation) throw new OfficeParseError('Missing ppt/presentation.xml');
  const relationships = await pkg.readRelationships('ppt/_rels/presentation.xml.rels', 'ppt');
  const slideIds = descendantsByName(presentation, 'sldId');
  const slides: SlideText[] = [];
  let chars = 0;
  let truncated = slideIds.length > MAX_SLIDES;
  for (const [index, slideId] of slideIds.slice(0, MAX_SLIDES).entries()) {
    await checkpoint();
    const target = relationships.get(relationshipId(slideId));
    const doc = target ? await pkg.readXml(target) : null;
    if (!doc) continue;
    const paragraphs = slideParagraphs(doc);
    chars += paragraphs.reduce((total, text) => total + text.length, 0);
    if (chars > MAX_TEXT_CHARS) {
      truncated = true;
      break;
    }
    slides.push({ number: index + 1, paragraphs });
  }
  // A template (.potx) may legitimately have no slides; show it as empty.
  return { slides, truncated };
}
