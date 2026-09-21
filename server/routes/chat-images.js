/**
 * chat-images routes — serves an image that was attached to a chat prompt.
 *
 * WHY IT IS A ROUTER AND NOT AN INLINE `app.get` (B-430 review): the handler
 * carries the whole access model for stored attachments, and a handler declared
 * inside server/index.js can only be exercised by booting the entire server.
 * As its own router it is mounted in one line and tested over real HTTP the way
 * the module routers are.
 *
 * ACCESS MODEL. The bucket is 16 random bytes minted per prompt and appears only
 * inside the session transcript, so possession of the path already implies read
 * access to that session; `authenticateToken` is the second lock. This is a
 * capability URL — it is NOT a substitute for the per-project ownership check
 * that lands with the retention work (ADR-100), and until then any authenticated
 * user who learns a bucket id can read that bucket.
 */
import express from 'express';

import { promises as fsPromises } from 'fs';

import { resolveChatImagePath } from '../services/chat-image-store.js';

/**
 * @param {{authenticateToken: import('express').RequestHandler}} deps
 * @returns {import('express').Router}
 */
export function createChatImagesRouter({ authenticateToken }) {
  const router = express.Router();

  router.get('/:bucket/:name', authenticateToken, async (req, res) => {
    // Path safety is delegated to resolveChatImagePath (strict bucket/name
    // patterns plus a containment check); a null result is a 404 and never a
    // fallback to the raw request input.
    const resolved = resolveChatImagePath(req.params.bucket, req.params.name);
    if (!resolved) {
      return res.status(404).json({ error: 'Image not found' });
    }

    try {
      const data = await fsPromises.readFile(resolved.absolutePath);
      res.setHeader('Content-Type', resolved.mimeType);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // The client always renders these through <img> (scripts inert there),
      // but a direct navigation to an SVG would be a document context — deny
      // every subresource and script so a hostile SVG has nothing to run with.
      // Stored SVGs are sanitized on write as well (chat-image-store).
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      // Short and revalidated, NOT immutable: a retention sweep will delete
      // these files, and a day-long immutable copy in the browser would keep
      // showing an image the server has already destroyed.
      res.setHeader('Cache-Control', 'private, max-age=300, must-revalidate');
      return res.send(data);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Image not found' });
      }
      console.error('Error serving chat image:', error);
      return res.status(500).json({ error: 'Failed to read image' });
    }
  });

  return router;
}
