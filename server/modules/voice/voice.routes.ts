/**
 * Voice routes (mounted at /api/voice by index.js behind authenticateToken)
 * — ADR-103 / T-1246.
 *
 *   GET    /api/voice/transcription/settings  → what the client may offer, and why
 *   PUT    /api/voice/transcription/settings  → owner only: switch + endpoint + caps
 *   PUT    /api/voice/transcription/key       → store a key (system | user scope)
 *   DELETE /api/voice/transcription/key       → forget a key
 *   POST   /api/voice/transcription           → one recording in, text out
 *
 * ── WHY THE FLAG GATE IS NOT ON EVERY ROUTE ──────────────────────────────────
 * A switched-off surface answers 404 so it is indistinguishable from a route
 * that was never mounted. That is right for the transcription call and for the
 * key writes. It is WRONG for the two settings routes: GET is how the client
 * learns that accurate mode is off (a 404 there would leave the microphone
 * silently degraded with no explanation), and PUT is the only way to switch it
 * back on — gating it on the flag would lock the owner out of their own feature
 * forever.
 *
 * ── AUTHORIZATION ────────────────────────────────────────────────────────────
 *   settings GET  — any authenticated member (it carries no secret).
 *   settings PUT  — owner. It changes where every member's key is sent.
 *   key   system  — owner/admin. One key, spent by everyone.
 *   key   user    — any member, for THEMSELVES only. The scope is taken from
 *                   req.user, never from the body, so "user" cannot address
 *                   somebody else's tree.
 * Every write is additionally refused in PLATFORM MODE, where authentication is
 * disabled and every caller reads as the first user, i.e. the owner
 * (middleware/auth.js:49-58, B-186). Same treatment as the governance write in
 * provider.routes.ts.
 *
 * ── WHAT NEVER CROSSES THIS BOUNDARY ─────────────────────────────────────────
 * The key (in either direction of read: responses carry booleans) and the audio.
 * The recording lives in memory for the duration of one request; no route here
 * writes it anywhere, and neither the audio nor the transcript reaches a log or
 * an audit row.
 */

import express from 'express';
import multer from 'multer';

import { auditLogDb } from '@/modules/database/index.js';
import {
  ALLOWED_AUDIO_MIME_TYPES,
  deleteTranscriptionKey,
  isVoiceTranscriptionEnabled,
  readVoiceTranscriptionConfig,
  requireVoiceTranscriptionEnabled,
  setTranscriptionKey,
  transcribeAudio,
  transcriptionKeyPresence,
  updateVoiceTranscriptionSettings,
  type TranscriptionKeyScope,
} from '@/modules/voice/voice-transcription.service.js';
import { AppError } from '@/shared/utils.js';

type AuthedRequest = express.Request & {
  user?: { id?: number; userId?: number; role?: string };
  file?: { mimetype: string; buffer: Buffer; originalname?: string; size: number };
};

const callerId = (req: express.Request): number | null => {
  const user = (req as AuthedRequest).user;
  const id = user?.id ?? user?.userId;
  const numeric = typeof id === 'string' ? Number(id) : id;
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null;
};

const callerRole = (req: express.Request): string | undefined =>
  (req as AuthedRequest).user?.role;

/**
 * Platform mode, read at CALL time from the variable `server/constants/config.js`
 * derives IS_PLATFORM from. Not imported from there because a module route may
 * not reach outside the module graph — the same one-line duplication
 * provider.routes.ts makes, for the same reason.
 */
const isPlatformMode = (): boolean => process.env.VITE_IS_PLATFORM === 'true';

/** Turns a thrown AppError into its own status; anything else is a 400. */
const fail = (res: express.Response, error: unknown): void => {
  if (error instanceof AppError) {
    res.status(error.statusCode ?? 400).json({ error: error.message, code: error.code });
    return;
  }
  const message = error instanceof Error ? error.message : 'Unknown error';
  res.status(400).json({ error: message });
};

/**
 * Refuses any write that platform mode would let an unauthenticated caller make.
 * Returns true when the request has already been answered.
 */
const refusedInPlatformMode = (res: express.Response): boolean => {
  if (!isPlatformMode()) {
    return false;
  }
  res.status(403).json({
    error: 'This setting cannot be changed while the server runs in platform mode.',
    code: 'PLATFORM_MODE_WRITE_REFUSED',
  });
  return true;
};

const router = express.Router();

/**
 * The one place that decides what the client may show, so the GET that offers a
 * button and the PUT that performs the write cannot disagree (B-362).
 *
 * `canManage` is false in platform mode even for the "owner", because there the
 * role is an artefact of the disabled authentication rather than an identity.
 */
const settingsPayload = (req: express.Request) => {
  const config = readVoiceTranscriptionConfig();
  const userId = callerId(req);
  const key = transcriptionKeyPresence(userId);
  return {
    enabled: config.enabled,
    canManage: callerRole(req) === 'owner' && !isPlatformMode(),
    baseUrl: config.baseUrl,
    model: config.model,
    maxMb: config.maxMb,
    key,
    available: config.enabled && (key.user || key.system),
  };
};

/**
 * Open to every authenticated member and NOT behind the flag gate: this is the
 * answer to "why does the microphone not offer accurate mode", so it must be
 * able to say `enabled:false` out loud.
 */
router.get('/transcription/settings', (req, res) => {
  try {
    res.json(settingsPayload(req));
  } catch (error) {
    fail(res, error);
  }
});

router.put('/transcription/settings', (req, res) => {
  if (callerRole(req) !== 'owner') {
    res.status(403).json({
      error: 'Only the owner can change transcription settings.',
      code: 'INSUFFICIENT_ROLE',
    });
    return;
  }
  if (refusedInPlatformMode(res)) return;
  try {
    updateVoiceTranscriptionSettings({
      enabled: req.body?.enabled,
      baseUrl: req.body?.baseUrl,
      model: req.body?.model,
      maxMb: req.body?.maxMb,
    });
    const payload = settingsPayload(req);
    // The switch, the endpoint and the ceiling are all security-relevant: the
    // endpoint decides where a paid key is sent. The row carries the resulting
    // values — never the key, which this route cannot even see.
    auditLogDb.record('voice_transcription_settings_updated', {
      userId: callerId(req),
      metadata: {
        enabled: payload.enabled,
        baseUrl: payload.baseUrl,
        model: payload.model,
        maxMb: payload.maxMb,
      },
    });
    res.json(payload);
  } catch (error) {
    fail(res, error);
  }
});

/**
 * Resolves the requested key scope and the authority to write it.
 * Returns the scope, or null when the request has already been answered.
 */
const resolveKeyScope = (
  req: express.Request,
  res: express.Response,
  raw: unknown,
): TranscriptionKeyScope | null => {
  if (callerId(req) === null) {
    res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
    return null;
  }
  if (raw !== 'system' && raw !== 'user') {
    res.status(400).json({ error: 'scope must be "system" or "user".', code: 'INVALID_SCOPE' });
    return null;
  }
  if (raw === 'system') {
    const role = callerRole(req);
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({
        error: 'Only an owner or admin can manage the installation key.',
        code: 'INSUFFICIENT_ROLE',
      });
      return null;
    }
  }
  // Both scopes: a write here either stores a credential in the operator's tree
  // or in a member's tree, and platform mode cannot tell those apart because it
  // has no identities at all.
  if (refusedInPlatformMode(res)) return null;
  return raw;
};

router.put('/transcription/key', requireVoiceTranscriptionEnabled, (req, res) => {
  const scope = resolveKeyScope(req, res, req.body?.scope);
  if (scope === null) return;
  try {
    setTranscriptionKey(scope, callerId(req), req.body?.apiKey);
    // Recorded because rotation is the only effective revocation, and because a
    // `system` write means every member now spends this credential. Metadata
    // carries the SCOPE only.
    auditLogDb.record('voice_transcription_key_set', {
      userId: callerId(req),
      metadata: { scope },
    });
    res.json({ scope, configured: true });
  } catch (error) {
    fail(res, error);
  }
});

router.delete('/transcription/key', requireVoiceTranscriptionEnabled, (req, res) => {
  const scope = resolveKeyScope(req, res, req.query?.scope);
  if (scope === null) return;
  try {
    const removed = deleteTranscriptionKey(scope, callerId(req));
    auditLogDb.record('voice_transcription_key_removed', {
      userId: callerId(req),
      metadata: { scope, removed },
    });
    res.json({ scope, configured: false });
  } catch (error) {
    fail(res, error);
  }
});

/**
 * A language hint is optional and, when present, must look like a BCP-47 tag.
 * ABSENT means auto-detect — the default, and the right answer for a bilingual
 * user who switches between Arabic and English mid-session.
 */
const normalizeLanguage = (raw: unknown): string | undefined => {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  if (typeof raw !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(raw.trim())) {
    throw new AppError('The language hint is not a valid language tag.', {
      code: 'INVALID_LANGUAGE',
      statusCode: 400,
    });
  }
  return raw.trim();
};

/**
 * @param deps.fetchImpl injected by the tests so no request leaves the machine.
 */
export function createVoiceRouter({ fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
  const voiceRouter = express.Router();
  voiceRouter.use(router);

  voiceRouter.post('/transcription', requireVoiceTranscriptionEnabled, (req, res) => {
    const userId = callerId(req);
    if (userId === null) {
      res.status(401).json({ error: 'Authentication required.', code: 'AUTH_REQUIRED' });
      return;
    }

    // Built PER REQUEST, not once at module load: the ceiling is an owner
    // setting that must bite on the next recording, not after a restart.
    const config = readVoiceTranscriptionConfig();
    const upload = multer({
      // memoryStorage is the requirement, not an optimisation: a recording of a
      // person's voice must not be written to disk anywhere, not even to a temp
      // file that a crash would leave behind.
      storage: multer.memoryStorage(),
      limits: {
        fileSize: config.maxBytes,
        files: 1,
        // `language` is the only text field; the slack is for multipart
        // boilerplate, not for extra payload.
        fields: 4,
        parts: 8,
        fieldSize: 256,
      },
      fileFilter: (_multerReq, file, callback) => {
        if (!ALLOWED_AUDIO_MIME_TYPES.includes(file.mimetype)) {
          callback(
            new AppError('That audio type is not supported.', {
              code: 'UNSUPPORTED_AUDIO_TYPE',
              statusCode: 415,
            }),
          );
          return;
        }
        callback(null, true);
      },
    }).single('audio');

    upload(req, res, async (uploadError: unknown) => {
      if (uploadError) {
        if (uploadError instanceof multer.MulterError) {
          if (uploadError.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({
              error: `The recording is larger than the ${config.maxMb} MB limit.`,
              code: 'AUDIO_TOO_LARGE',
              maxMb: config.maxMb,
            });
            return;
          }
          res.status(400).json({ error: 'The upload was rejected.', code: 'INVALID_UPLOAD' });
          return;
        }
        fail(res, uploadError);
        return;
      }

      const file = (req as AuthedRequest).file;
      if (!file || !file.buffer || file.buffer.length === 0) {
        res.status(400).json({ error: 'No recording was attached.', code: 'EMPTY_AUDIO' });
        return;
      }

      try {
        const language = normalizeLanguage((req.body as { language?: unknown } | undefined)?.language);
        const result = await transcribeAudio(
          {
            userId,
            audio: file.buffer,
            mimeType: file.mimetype,
            filename: 'recording',
            language,
          },
          { fetchImpl },
        );
        // One row per transcription: cheap next to the network call it just
        // made, and the only way to answer "who is spending the installation
        // key". Carries the paying scope and the byte count — never the audio
        // and never the text.
        auditLogDb.record('voice_transcription_used', {
          userId,
          metadata: { keyScope: result.keyScope, bytes: file.buffer.length },
        });
        res.json(result.language ? { text: result.text, language: result.language } : { text: result.text });
      } catch (error) {
        fail(res, error);
      }
    });
  });

  return voiceRouter;
}

/** Production instance: the global fetch, no injection. */
export default createVoiceRouter();

export { isVoiceTranscriptionEnabled };
