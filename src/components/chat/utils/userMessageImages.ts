import type { ChatImage } from '../types/types';

import { extractChatImagesFromPrompt } from './chatImageNote';

/**
 * Merge provider-embedded history images with Claude's durable-store note.
 * Both may coexist during migrations, so sources are deduplicated.
 */
export function userMessageImages(content: string, embedded: unknown): ChatImage[] {
  const merged = extractChatImagesFromPrompt(content);
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
