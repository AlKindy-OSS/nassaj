import type { ChatImage } from '../types/types';

import { chatImagesFromRefs, extractChatImagesFromPrompt } from './chatImageNote';

/**
 * Merge provider-embedded history images with Claude's durable-store note and,
 * for a steer (B-1697), the store refs `{bucket,name}` the server attaches.
 * Sources may coexist during migrations, so they are deduplicated.
 */
export function userMessageImages(content: string, embedded: unknown): ChatImage[] {
  const merged = extractChatImagesFromPrompt(content);
  for (const image of chatImagesFromRefs(embedded)) {
    if (!merged.some((known) => known.data === image.data)) merged.push(image);
  }
  const seen = new Set(merged.map((image) => image.data));

  if (!Array.isArray(embedded)) return merged;
  let embeddedIndex = 0;
  for (const candidate of embedded) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const data = candidate.trim();
    if (seen.has(data)) continue;
    seen.add(data);
    embeddedIndex += 1;
    merged.push({ data, name: `image_${embeddedIndex}` });
  }

  return merged;
}
