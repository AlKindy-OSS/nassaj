import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { projectsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';
import { detectImageExt, IMAGE_MIME_TO_EXT } from '@/services/image-signature.js';
import { sanitizeSvg } from '@/services/svg-sanitizer.js';

/**
 * Per-project logo storage (T-1403).
 *
 * Mirrors the app-wide branding logo (server/routes/settings.js) deliberately,
 * down to the security decisions, because the two do the same dangerous thing:
 * persist a user-supplied image and serve it same-origin.
 *
 *   - The stored extension comes from the file's MAGIC BYTES (detectImageExt),
 *     never from the declared MIME type nor the uploaded filename.
 *   - SVG is sanitized (DOMPurify) before any disk write; only the cleaned
 *     markup is persisted, and the read route adds a strict CSP + nosniff.
 *   - The on-disk name is `<projectId>.<ext>` where projectId is the DB-assigned
 *     UUID resolved from an authorized route — no part of it is client text.
 *
 * Files live under the user's home dir (NOT inside dist/, which the build
 * overwrites), so a logo survives `npm run build` and pm2 deploys.
 */
export const PROJECT_LOGOS_ROOT = path.join(os.homedir(), '.nassaj-users', '.project-logos');

export const PROJECT_LOGO_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

export const PROJECT_LOGO_MIME_TO_EXT: Record<string, string> = IMAGE_MIME_TO_EXT;

const PROJECT_LOGO_EXTS: string[] = Object.values(IMAGE_MIME_TO_EXT);

/**
 * Shape of the project_id values this feature will ever touch: the UUID minted
 * by projectsDb.createProjectPath. The serving route in server/index.js applies
 * the SAME test to the URL segment before it builds a path, so neither side can
 * be handed a traversal sequence — this is the one definition of "safe id".
 */
const PROJECT_ID_PATTERN = /^[0-9a-fA-F-]{36}$/;

export function isSafeProjectLogoId(projectId: unknown): boolean {
  return typeof projectId === 'string' && PROJECT_ID_PATTERN.test(projectId);
}

function logoFilePath(projectId: string, ext: string): string {
  return path.join(PROJECT_LOGOS_ROOT, `${projectId}.${ext}`);
}

/** Removes every stored logo file for a project, whatever its extension. */
async function removeLogoFiles(projectId: string): Promise<void> {
  await Promise.all(
    PROJECT_LOGO_EXTS.map((ext) =>
      fs.promises.rm(logoFilePath(projectId, ext), { force: true }).catch(() => {}),
    ),
  );
}

/**
 * Validates and stores an uploaded logo for a project, returning the public URL
 * persisted on the project row.
 *
 * Throws AppError (400) when the bytes are not one of the allowed image formats
 * or an SVG does not survive sanitization — the buffer is never written in that
 * case. The caller is responsible for authorization BEFORE calling this.
 */
export async function saveProjectLogo(projectId: string, buffer: Buffer): Promise<string> {
  if (!isSafeProjectLogoId(projectId)) {
    throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }

  const ext = detectImageExt(buffer) as string | null;
  if (!ext) {
    throw new AppError('Unsupported image type', { code: 'UNSUPPORTED_IMAGE', statusCode: 400 });
  }

  let outputBuffer = buffer;
  if (ext === 'svg') {
    const sanitized = sanitizeSvg(buffer.toString('utf8')) as string | null;
    if (!sanitized) {
      throw new AppError('Unsupported image type', { code: 'UNSUPPORTED_IMAGE', statusCode: 400 });
    }
    outputBuffer = Buffer.from(sanitized, 'utf8');
  }

  await fs.promises.mkdir(PROJECT_LOGOS_ROOT, { recursive: true });

  // Drop any logo stored under a DIFFERENT extension first, so a replaced logo
  // never leaves a stale file that the serving route could still resolve.
  await Promise.all(
    PROJECT_LOGO_EXTS.filter((otherExt) => otherExt !== ext).map((otherExt) =>
      fs.promises.rm(logoFilePath(projectId, otherExt), { force: true }).catch(() => {}),
    ),
  );

  await fs.promises.writeFile(logoFilePath(projectId, ext), outputBuffer);

  // The cache-busting token makes every upload a brand-new URL, so a replaced
  // logo is never served from a cached copy of the previous one.
  const logoUrl = `/project-logos/${projectId}.${ext}?v=${Date.now()}`;
  projectsDb.setProjectLogoUrl(projectId, logoUrl);
  return logoUrl;
}

/** Removes a project's logo (files + row value). Idempotent. */
export async function deleteProjectLogo(projectId: string): Promise<void> {
  if (!isSafeProjectLogoId(projectId)) {
    throw new AppError('Project not found', { code: 'PROJECT_NOT_FOUND', statusCode: 404 });
  }
  await removeLogoFiles(projectId);
  projectsDb.setProjectLogoUrl(projectId, null);
}

/**
 * Best-effort cleanup hook for project deletion: the row is going away, so its
 * logo file would otherwise be orphaned on disk forever. Never throws.
 */
export async function purgeProjectLogoFiles(projectId: string): Promise<void> {
  if (!isSafeProjectLogoId(projectId)) {
    return;
  }
  await removeLogoFiles(projectId);
}
