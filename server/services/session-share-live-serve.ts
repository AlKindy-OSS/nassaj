/**
 * Resolution and loading of live read-link attachments (ADR-205 D4), all
 * through the existing validators:
 *   - chat-image      → resolveChatImagePath (B-430) + contained descriptor read
 *   - inbox-file      → resolveInboxAttachment (B-1374) + contained descriptor read
 *   - assistant-image → resolveImageWithinRoots over deriveAllowedRoots (ADR-157)
 *   - embedded-image  → the re-validated data URI from the transcript; no filesystem
 *
 * Images are raster only, by magic bytes (SVG is never served, B-158). Files
 * follow policy (a) (N2): only text-like files are served, as their
 * sanitizeShareText-redacted bytes; anything else is withheld. Locators are
 * server-only and never leave this process.
 */
import path from 'node:path';

import { deriveAllowedRoots, detectImageType, resolveImageWithinRoots } from '../routes/assistant-images.js';
import { resolveInboxAttachment } from '../utils/attachment-inbox.js';

import { getChatImageRoot, resolveChatImagePath } from './chat-image-store.js';
import { sanitizeAttachmentName, type AttachmentLocator } from './session-share-live-attachments.js';
import {
  ATTACHMENT_MAX_BYTES, TEXT_PROBE_BYTES, isSecretLocation, isTextLike, readContainedFile, realRootOf,
} from './session-share-live-files.js';
import { sanitizeShareText, type ShareTextCounts } from './session-share-sanitize.js';

/** Where an attachment is read from: the session and the context of its projection. */
export type AttachmentContext = { sessionId: string; projectRoot: string | null; home: string | null };
export type AttachmentPayload =
  | { ok: true; kind: 'image'; contentType: string; bytes: Buffer }
  | { ok: true; kind: 'file'; name: string; bytes: Buffer }
  | { ok: false; reason: 'gone' | 'too_large' };

const GONE: AttachmentPayload = { ok: false, reason: 'gone' };
const EMBEDDED_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})$/;
const INBOX = ['.nassaj-uploads', 'inbox'];

/** The retained-handle result of the ADR-157 validator (a JS module, typed here). */
type OpenedImage =
  | { ok: true; realResolved: string; size: number; handle: { read: (b: Buffer, o: number, l: number, p: number) => Promise<{ bytesRead: number }> };
    verify: () => Promise<void>; close: () => Promise<void> }
  | { ok: false; status: number };

const counts = (): ShareTextCounts => ({ system: 0, image: 0, secret: 0, path: 0, network: 0 });

/** Raster image payload when the magic bytes say png/jpeg/gif/webp; otherwise gone. */
function rasterImage(bytes: Buffer): AttachmentPayload {
  const contentType = detectImageType(bytes.subarray(0, 16));
  return contentType ? { ok: true, kind: 'image', contentType, bytes } : GONE;
}

/** The project inbox's real root for a session, or null. */
function inboxRoot(projectRoot: string | null): string | null {
  return projectRoot ? realRootOf(path.join(projectRoot, ...INBOX)) : null;
}

async function loadChatImage(locator: Extract<AttachmentLocator, { source: 'chat-image' }>): Promise<AttachmentPayload> {
  const resolved = resolveChatImagePath(locator.bucket, locator.name);
  const root = realRootOf(getChatImageRoot());
  if (!resolved || !root) return GONE;
  const read = readContainedFile(root, resolved.absolutePath);
  if (!read.ok) return read.reason === 'too_large' ? { ok: false, reason: 'too_large' } : GONE;
  return rasterImage(read.bytes);
}

/** Text parts verbatim; a redaction becomes its marker text. */
function renderSanitized(text: string, ctx: AttachmentContext): string {
  return sanitizeShareText(text, ctx, counts())
    .map((part) => (part.t === 'text' ? part.text : part.text ?? `[redacted:${part.cat}]`))
    .join('');
}

async function loadInboxFile(locator: Extract<AttachmentLocator, { source: 'inbox-file' }>,
  ctx: AttachmentContext): Promise<AttachmentPayload> {
  const resolved = ctx.projectRoot ? resolveInboxAttachment(ctx.projectRoot, locator.path) : null;
  const root = inboxRoot(ctx.projectRoot);
  if (!resolved || !root) return GONE;
  const read = readContainedFile(root, resolved);
  if (!read.ok) return read.reason === 'too_large' ? { ok: false, reason: 'too_large' } : GONE;
  if (!read.complete || !isTextLike(read.bytes, true)) return GONE;
  const name = sanitizeAttachmentName(path.basename(locator.path), ctx, counts());
  return { ok: true, kind: 'file', name, bytes: Buffer.from(renderSanitized(read.bytes.toString('utf8'), ctx), 'utf8') };
}

async function loadAssistantImage(locator: Extract<AttachmentLocator, { source: 'assistant-image' }>,
  ctx: AttachmentContext): Promise<AttachmentPayload> {
  const roots = deriveAllowedRoots({ projectRoot: ctx.projectRoot, sessionId: ctx.sessionId });
  if (roots.length === 0) return GONE;
  const opened = await resolveImageWithinRoots(roots, locator.path, { retainHandle: true }) as OpenedImage;
  if (!opened.ok) return opened.status === 413 ? { ok: false, reason: 'too_large' } : GONE;
  try {
    await opened.verify();
    if (isSecretLocation(opened.realResolved)) return GONE;
    const bytes = Buffer.alloc(opened.size);
    const { bytesRead } = await opened.handle.read(bytes, 0, opened.size, 0);
    return bytesRead === opened.size ? rasterImage(bytes) : GONE;
  } catch {
    return GONE;
  } finally {
    await opened.close();
  }
}

function loadEmbeddedImage(locator: Extract<AttachmentLocator, { source: 'embedded-image' }>): AttachmentPayload {
  const match = EMBEDDED_IMAGE.exec(locator.dataUri);
  if (!match) return GONE;
  const bytes = Buffer.from(match[2], 'base64');
  const sniffed = rasterImage(bytes);
  return sniffed.ok && sniffed.kind === 'image' && sniffed.contentType === `image/${match[1]}` ? sniffed : GONE;
}

/**
 * Loads one attachment for a guest. Missing, moved, non-regular, symlinked,
 * escaping, secret, non-raster or non-text targets are all `gone`.
 */
export async function loadAttachment(locator: AttachmentLocator, ctx: AttachmentContext): Promise<AttachmentPayload> {
  switch (locator.source) {
    case 'chat-image': return loadChatImage(locator);
    case 'inbox-file': return loadInboxFile(locator, ctx);
    case 'assistant-image': return loadAssistantImage(locator, ctx);
    case 'embedded-image': return loadEmbeddedImage(locator);
    default: return GONE;
  }
}

/**
 * Projection-time policy (a) check for a file attachment: true only for an
 * inbox file that exists, is regular, within the cap, contained, not secret,
 * and whose first bytes are text-like. Anything else is projected as
 * `attachment-unavailable` and mints no ref.
 */
export function isServableTextFile(projectRoot: string | null, locator: AttachmentLocator): boolean {
  if (locator.source !== 'inbox-file' || !projectRoot) return false;
  const resolved = resolveInboxAttachment(projectRoot, locator.path);
  const root = inboxRoot(projectRoot);
  if (!resolved || !root) return false;
  const read = readContainedFile(root, resolved, { maxBytes: ATTACHMENT_MAX_BYTES, readBytes: TEXT_PROBE_BYTES });
  return read.ok && isTextLike(read.bytes, read.complete);
}
