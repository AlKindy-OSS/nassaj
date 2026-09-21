/**
 * assistant-images routes — serves an image the ASSISTANT referenced by an
 * absolute on-disk path inside a session's own file surface (ADR-157).
 *
 * WHY IT IS A ROUTER AND NOT AN INLINE `app.get` (mirrors chat-images.js): the
 * handler carries the whole read-access model, and a handler declared inside
 * server/index.js can only be exercised by booting the entire server. As its own
 * router it is mounted in one line and tested over real HTTP.
 *
 * ACCESS MODEL. Unlike chat-images (a capability URL to a stored attachment),
 * this endpoint accepts an arbitrary absolute path, so the boundary is the
 * allow-list of roots derived SERVER-SIDE from the session — never a value the
 * client sends. The allowed roots are exactly the session's project root and the
 * session scratchpad dir; `/home/operator` is deliberately NOT a root (qa-critic
 * ح-1, least privilege). Layered defence, in order: dot-segment rejection,
 * symlink-aware containment (reused path-guard), size cap, and a magic-bytes
 * content sniff so the Content-Type is derived from the file, not its name
 * (qa-critic ح-2) — `nosniff` then binds the browser to that verdict.
 */
import express from 'express';

import os from 'node:os';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';

import { resolveReadPathInProject } from '../utils/path-guard.js';
import { createRateLimiter } from '../middleware/rate-limit.js';

/** Largest image body served; larger files are refused with 413. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Identify an image type from its leading bytes (magic-bytes sniff). Only the
 * four raster formats the assistant surface allows are recognised; SVG and every
 * other type return null so the caller answers 415. The Content-Type ships from
 * THIS verdict, never from the file extension.
 *
 * @param {Buffer} head First bytes of the file (>= 12 needed for WebP).
 * @returns {'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null}
 */
export function detectImageType(head) {
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e &&
      head[3] === 0x47 && head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (head.length >= 6 && head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 &&
      head[3] === 0x38 && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
    return 'image/gif';
  }
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Encode a project root the way the harness names scratchpad dirs on disk: every
 * '/' and '.' becomes '-' (confirmed on disk, e.g. `.../nassaj-dev/.git` ->
 * `-...-nassaj-dev--git`).
 *
 * @param {string} projectRoot Absolute project root.
 * @returns {string}
 */
export function encodeProjectPathForScratchpad(projectRoot) {
  return projectRoot.replace(/[/.]/g, '-');
}

/**
 * The scratchpad base dir the CLI writes under: `<TMPDIR>/claude-<uid>`.
 * Overridable with NASSAJ_SCRATCHPAD_BASE when the server process TMPDIR differs
 * from the CLI's.
 *
 * @returns {string}
 */
export function defaultScratchpadBase() {
  if (process.env.NASSAJ_SCRATCHPAD_BASE) {
    return process.env.NASSAJ_SCRATCHPAD_BASE;
  }
  const tmp = process.env.TMPDIR || os.tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return path.join(tmp, `claude-${uid}`);
}

/**
 * The per-request allow-list: the session's project root plus its scratchpad
 * dir. `/home/operator` is intentionally absent (least privilege). Both roots come
 * from server-resolved session state, never from the request.
 *
 * @param {{projectRoot: string, sessionId: string, scratchpadBase: string}} args
 * @returns {string[]}
 */
export function deriveAllowedRoots({ projectRoot, sessionId, scratchpadBase }) {
  const roots = [];
  if (projectRoot) {
    roots.push(projectRoot);
    if (scratchpadBase && sessionId) {
      roots.push(path.join(scratchpadBase, encodeProjectPathForScratchpad(projectRoot), sessionId, 'scratchpad'));
    }
  }
  return roots;
}

/**
 * True when any path segment BELOW `rootAbs` starts with '.' (`.ssh`, `.env`,
 * `.git` ...). The root prefix itself is exempt — a scratchpad root legitimately
 * lives under `.cache` — so the check is on the portion relative to the root.
 *
 * @param {string} rootAbs Absolute allowed root.
 * @param {string} target  Absolute path already known to be under rootAbs.
 * @returns {boolean}
 */
export function hasDotSegment(rootAbs, target) {
  const rel = path.relative(rootAbs, target);
  if (rel === '') {
    return false;
  }
  return rel.split(path.sep).some((seg) => seg.startsWith('.'));
}

/**
 * Open the file, confirm it is a servable image, and derive its Content-Type
 * from a magic-bytes sniff. Also re-checks dot-segments on the REAL path so a
 * symlink cannot redirect onto a hidden file inside the tree.
 *
 * @param {string} rootAbs      Matched allowed root.
 * @param {string} realResolved Canonical, containment-verified path.
 * @returns {Promise<{ok:true,contentType:string,realResolved:string,size:number}|{ok:false,status:number,error:string}>}
 */
async function finalizeImage(rootAbs, realResolved) {
  const realRoot = await realpath(rootAbs);
  if (hasDotSegment(realRoot, realResolved)) {
    return { ok: false, status: 403, error: 'Path not allowed' };
  }
  const info = await stat(realResolved);
  if (!info.isFile()) {
    return { ok: false, status: 404, error: 'Image not found' };
  }
  if (info.size > MAX_IMAGE_BYTES) {
    return { ok: false, status: 413, error: 'Image too large' };
  }
  const fh = await open(realResolved, 'r');
  try {
    const buf = Buffer.alloc(16);
    const { bytesRead } = await fh.read(buf, 0, 16, 0);
    const contentType = detectImageType(buf.subarray(0, bytesRead));
    if (!contentType) {
      return { ok: false, status: 415, error: 'Unsupported image type' };
    }
    return { ok: true, contentType, realResolved, size: info.size };
  } finally {
    await fh.close();
  }
}

/**
 * The security pipeline. Resolves an absolute requested path against the allowed
 * roots and returns either a servable result or the exact refusal status.
 * Order (qa-critic contract): non-absolute -> 400; dot-segment -> 403; symlink
 * escape -> 403; no root -> 403; ENOENT -> 404; oversize -> 413; non-image -> 415.
 *
 * @param {string[]} allowedRoots Absolute roots, first containment wins.
 * @param {string} requestedPath  Client-supplied absolute path.
 * @returns {Promise<{ok:true,contentType:string,realResolved:string,size:number}|{ok:false,status:number,error:string}>}
 */
export async function resolveImageWithinRoots(allowedRoots, requestedPath) {
  if (typeof requestedPath !== 'string' || !path.isAbsolute(requestedPath)) {
    return { ok: false, status: 400, error: 'Invalid image path' };
  }
  const resolved = path.resolve(requestedPath);
  let sawEnoent = false;
  for (const root of allowedRoots) {
    const rootAbs = path.resolve(root);
    if (resolved !== rootAbs && !resolved.startsWith(rootAbs + path.sep)) {
      continue;
    }
    if (hasDotSegment(rootAbs, resolved)) {
      return { ok: false, status: 403, error: 'Path not allowed' };
    }
    const guard = await resolveReadPathInProject(rootAbs, requestedPath);
    if (!guard.valid) {
      if (guard.code === 'ENOENT') {
        sawEnoent = true;
        continue;
      }
      return { ok: false, status: 403, error: 'Path not allowed' };
    }
    return finalizeImage(rootAbs, guard.realResolved);
  }
  return sawEnoent
    ? { ok: false, status: 404, error: 'Image not found' }
    : { ok: false, status: 403, error: 'Path not allowed' };
}

/** Apply the hardening + cache headers to an image response. */
function setImageHeaders(res, contentType) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
}

/**
 * @param {{
 *   authenticateToken: import('express').RequestHandler,
 *   resolveAllowedRoots: (sessionId: string, userId: unknown) => string[] | null,
 *   limiter?: import('express').RequestHandler,
 * }} deps
 * @returns {import('express').Router}
 */
export function createAssistantImagesRouter({ authenticateToken, resolveAllowedRoots, limiter }) {
  const router = express.Router();
  const gate = limiter || createRateLimiter({
    windowMs: 60_000,
    max: 120,
    message: 'Too many image requests, please slow down',
  });

  router.get('/', gate, authenticateToken, async (req, res) => {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    const sessionId = typeof req.query.session === 'string' ? req.query.session : '';
    if (!requestedPath || !sessionId || !path.isAbsolute(requestedPath)) {
      return res.status(400).json({ error: 'Invalid image request' });
    }

    // Ownership + root derivation happen SERVER-SIDE from session state; a
    // null result means the session is unknown or not owned by the caller.
    const allowedRoots = resolveAllowedRoots(sessionId, req.user?.id);
    if (!allowedRoots || allowedRoots.length === 0) {
      return res.status(403).json({ error: 'Session not accessible' });
    }

    try {
      const result = await resolveImageWithinRoots(allowedRoots, requestedPath);
      if (!result.ok) {
        return res.status(result.status).json({ error: result.error });
      }
      setImageHeaders(res, result.contentType);
      const stream = createReadStream(result.realResolved);
      stream.on('error', () => {
        if (res.headersSent) {
          res.destroy();
        } else {
          res.status(500).json({ error: 'Failed to load image' });
        }
      });
      return stream.pipe(res);
    } catch (error) {
      // No path in the log line (avoids leaking absolute paths into logs).
      console.error('assistant-images: failed to serve image:', error?.code || error?.message);
      return res.status(500).json({ error: 'Failed to load image' });
    }
  });

  return router;
}
