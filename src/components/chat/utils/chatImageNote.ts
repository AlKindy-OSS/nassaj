import type { ChatImage } from '../types/types';

/**
 * B-430 — recovers the pictures attached to a user prompt from the prompt text.
 *
 * A transcript row carries no attachment metadata: the only trace an image ever
 * leaves is the `[Images provided at the following paths:]` note the server
 * appends, listing absolute paths. So the moment a live message (which does
 * carry base64 in memory) is replaced by its transcript twin, the picture can
 * only come back by reading those paths — which is why the store's layout
 * (`chat-images/<32-hex bucket>/image_<n>.<ext>`) is matched here directly.
 *
 * Only paths inside the durable store are recognized. Pre-B-430 messages point
 * at `/tmp/nassaj-claude-images/...` files that were deleted when the query
 * ended, and paths the user merely typed are not attachments — both are left
 * alone rather than turned into a broken <img>.
 */
const STORED_IMAGE_PATTERN =
  /chat-images\/([0-9a-f]{32})\/(image_\d+\.(?:png|jpe?g|gif|webp|svg))/g;

/**
 * The exact block the server appends (claude-sdk handleImages). Matching the
 * block — rather than scanning the whole message — is a correctness AND an
 * access-control decision (qa-critic): a bucket id pasted anywhere in a message
 * body would otherwise be fetched and rendered, turning ordinary text into a
 * retrieval channel for someone else's attachment.
 */
const IMAGE_NOTE_BLOCK =
  /\n*\[Images provided at the following paths:\]\n(?:\s*\d+\.[^\n]*\n?)+/g;

function matchNoteBlocks(content: string): string[] {
  IMAGE_NOTE_BLOCK.lastIndex = 0;
  return content.match(IMAGE_NOTE_BLOCK) ?? [];
}

export function extractChatImagesFromPrompt(content: string): ChatImage[] {
  if (!content || !content.includes('chat-images/')) return [];

  const images: ChatImage[] = [];
  const seen = new Set<string>();

  for (const block of matchNoteBlocks(content)) {
    // Fresh lastIndex per block: the /g regex is module-level and would
    // otherwise resume mid-string on the next block or message.
    STORED_IMAGE_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STORED_IMAGE_PATTERN.exec(block)) !== null) {
      const [, bucket, name] = match;
      const url = `/api/chat-images/${bucket}/${name}`;
      if (seen.has(url)) continue;
      seen.add(url);
      images.push({ name, data: url });
    }
  }

  return images;
}

/**
 * Removes the appended path note from the text shown to humans.
 *
 * The note carries the absolute server path AND the 128-bit bucket id, which is
 * the capability that guards the image (qa-critic): leaving it on screen puts
 * that secret into every screenshot, every "copy message", and every re-paste
 * into another tool. The model still receives the full text — only the rendered
 * bubble is trimmed, and the picture itself is shown right below it instead.
 */
export function stripChatImageNote(content: string): string {
  if (!content || !content.includes('[Images provided at the following paths:]')) {
    return content;
  }
  IMAGE_NOTE_BLOCK.lastIndex = 0;
  return content.replace(IMAGE_NOTE_BLOCK, '').trimEnd();
}
