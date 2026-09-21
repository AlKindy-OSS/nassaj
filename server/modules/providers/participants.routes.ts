/**
 * Participant tracking routes (mounted at /api/sessions).
 *
 *   GET    /api/sessions/starred                 → the caller's starred sessions
 *   POST   /api/sessions/star                     → star/unstar a session for the caller
 *   GET    /api/sessions/:sessionId/participants  → human participants of a session
 *   GET    /api/sessions/:sessionId/agents        → model + subagents of a session
 *   POST   /api/sessions/:sessionId/close         → mark a conversation finished
 *   DELETE /api/sessions/:sessionId/close         → reopen it
 *
 * All are auth-protected by the mount point in index.js. Handlers stay thin:
 * validate input, delegate to the relevant service/repository, shape response.
 */

import express, { type Request, type Response } from 'express';

import { closedSessionsDb, projectsDb, sessionOutcomesDb, sessionsDb, starredSessionsDb } from '@/modules/database/index.js';
import { participantsService } from '@/modules/providers/services/participants.service.js';
import { notifySessionMetadataChanged } from '@/modules/providers/services/sessions-watcher.service.js';
import { assertSessionAccessible } from '@/modules/providers/services/sessions.service.js';
import { notifyOutcomeChanged } from '@/modules/websocket/index.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;
const PROJECT_NAME_PATTERN = /^[a-zA-Z0-9._/-]{1,400}$/;

function parseSessionId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!SESSION_ID_PATTERN.test(raw)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }
  return raw;
}

function parseExpectedOutcomeAt(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(raw)) {
    throw new AppError('Invalid expectedOutcomeAt.', {
      code: 'INVALID_OUTCOME_VERSION',
      statusCode: 400,
    });
  }
  return raw;
}

/**
 * Provider of a session, for the refresh broadcast only. The broadcast payload
 * carries it as a hint; a session whose row has vanished still deserves the
 * refresh, so an unknown provider falls back to 'claude' rather than skipping
 * the notification and leaving every sidebar stale.
 */
function sessionProviderForBroadcast(sessionId: string) {
  const provider = sessionsDb.getSessionById(sessionId)?.provider;
  return (provider ?? 'claude') as Parameters<typeof notifySessionMetadataChanged>[0];
}

/** Optional projectName from a request body; null when absent, validated when present. */
function parseOptionalProjectName(value: unknown): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!PROJECT_NAME_PATTERN.test(raw)) {
    throw new AppError('Invalid projectName.', {
      code: 'INVALID_PROJECT_NAME',
      statusCode: 400,
    });
  }
  return raw;
}

type AuthenticatedUser = { id?: number | string };

/**
 * Reads the authenticated user's numeric id from req.user (set by
 * authenticateToken at the mount point). Stars are ALWAYS scoped to this id —
 * never to any user identifier taken from request input.
 */
function readAuthenticatedUserId(req: Request): number {
  const rawId = (req as Request & { user?: AuthenticatedUser }).user?.id;
  const userId =
    typeof rawId === 'number'
      ? rawId
      : typeof rawId === 'string' && rawId.trim() !== ''
        ? Number.parseInt(rawId, 10)
        : NaN;

  if (!Number.isInteger(userId)) {
    throw new AppError('Authentication required.', {
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    });
  }
  return userId;
}

router.get(
  '/starred',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readAuthenticatedUserId(req);
    // A star is only a pointer, never an authorization grant. The repository
    // applies the shared read predicate set-wise so stale/inaccessible rows are
    // omitted without an N+1 authorization query or an existence disclosure.
    const sessions = starredSessionsDb.listAccessibleStarredSessions(userId);
    res.json(createApiSuccessResponse({ sessions }));
  })
);

router.post(
  '/star',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readAuthenticatedUserId(req);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const sessionId = parseSessionId(body.sessionId);
    const projectName = parseOptionalProjectName(body.projectName);

    if (typeof body.starred !== 'boolean') {
      throw new AppError('Field "starred" must be a boolean.', {
        code: 'INVALID_STARRED_FLAG',
        statusCode: 400,
      });
    }

    // Creating a pointer requires read entitlement. Removing one's own pointer
    // does not: it remains idempotent after the session disappears or access is
    // lost, and always answers 200 rather than becoming an existence oracle.
    if (body.starred) {
      assertSessionAccessible(sessionId, userId, 'read');
    }
    const starred = starredSessionsDb.setStarred(userId, sessionId, body.starred, projectName);
    // A star lives only in the DB, so no file watcher will ever notice it — the
    // same reason /close broadcasts below. Unlike `closed` the flag is PER USER,
    // so this is only honest now that the broadcast builds one payload per
    // recipient identity (B-825): every socket receives its own `starred`, and
    // the sidebar's optimistic overlay is confirmed by the server instead of
    // being contradicted by it.
    notifySessionMetadataChanged(sessionProviderForBroadcast(sessionId), sessionId);
    res.json(createApiSuccessResponse({ sessionId, projectName, starred }));
  })
);

// The two routes below describe WHO (humans) and WHAT (model + subagents) is
// working inside one session. Both ran on the sessionId alone, so any
// authenticated user could enumerate the collaborators — and the agent roster
// parsed out of the transcript — of a session in a project they cannot see.
// They now pass through the shared session gate in 'read' mode (participation OR
// project visibility), which answers 404 on refusal so the session's existence is
// not disclosed either. Placed BEFORE the service call so nothing is read from
// the database or the transcript for an unauthorized caller.
router.get(
  '/:sessionId/participants',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    assertSessionAccessible(sessionId, readAuthenticatedUserId(req), 'read');
    const participants = participantsService.listSessionParticipants(sessionId);
    res.json(createApiSuccessResponse({ participants }));
  })
);

router.get(
  '/:sessionId/agents',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    assertSessionAccessible(sessionId, readAuthenticatedUserId(req), 'read');
    // `{ agents, harness, engine }` — the two provider axes travel with the
    // roster because the header draws the harness mark next to the model name
    // (B-410) and neither axis is derivable from the agent rows themselves.
    const view = await participantsService.listSessionAgents(sessionId);
    res.json(createApiSuccessResponse(view));
  })
);

// Closing marks a conversation as finished. Unlike a star the flag is GLOBAL —
// every member of the project sees the same state — which is exactly why the
// gate here is 'write' and not 'read': every project defaults to public, so the
// read predicate would let ANY authenticated user close (or reopen) every
// conversation in every public project. 'write' keeps the action with the people
// who own the conversation or the project.
//
// The state itself is presentation-only and reversible: nothing in the
// resume/read path consults it, POST and DELETE are both idempotent, and
// re-closing preserves the ORIGINAL closer so "who finished this" stays honest.
// The response is flat (`{ success, closed }`) per the sidebar contract.
router.post(
  '/:sessionId/close',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const userId = readAuthenticatedUserId(req);
    assertSessionAccessible(sessionId, userId, 'write');

    closedSessionsDb.closeSession(sessionId, userId);
    // Read back rather than echo the request: on a repeat close the stored
    // marker still names the FIRST closer, and that is what the caller must see.
    const closed = closedSessionsDb.getClosedSession(sessionId);
    // The flag lives only in the DB, so no file watcher will ever notice it.
    // Without this the sidebar keeps the value it last fetched and the row looks
    // untouched until a reload — which is exactly how this shipped broken.
    notifySessionMetadataChanged(sessionProviderForBroadcast(sessionId), sessionId);
    res.json({ success: true, closed });
  })
);

router.delete(
  '/:sessionId/close',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    assertSessionAccessible(sessionId, readAuthenticatedUserId(req), 'write');

    closedSessionsDb.reopenSession(sessionId);
    notifySessionMetadataChanged(sessionProviderForBroadcast(sessionId), sessionId);
    res.json({ success: true });
  })
);

/**
 * ‏T-1340 — الأحكام المشتركة الظاهرة للطالب ضمن نطاق رؤيته: لقطة العدّاد.
 *
 * الشريط الجانبي مُصفَّح فقد لا يحمل كل الجلسات، ومطلبُ المالك أن يعرف «عدد
 * المحادثات النشطة وحالتها». فهذه تُعيد **الظاهر عالمياً** ضمن مشاريعه
 * المرئية — عشرات الصفوف باستعلامٍ مفهرس واحد، لا 247 محادثة.
 *
 * ولا تنشر شيئاً عن جلسةٍ لا يراها الطالب: لا صفّاً ولا عدداً. وهذا **يخالف
 * عمداً** ما يفعله presence (ينشر عدداً مخفياً ليصدق رقمُ «من يعمل الآن»):
 * ذاك رقمٌ مجمَّع، وهذه دعوى على محادثةٍ بعينها. لا «تصحّح» التباين لاحقاً.
 */
router.get(
  '/outcomes/unseen',
  asyncHandler(async (req: Request, res: Response) => {
    const userId = readAuthenticatedUserId(req);
    if (!userId) {
      res.json({ outcomes: [] });
      return;
    }
    const visiblePaths = projectsDb.getVisibleProjectPaths(userId);
    res.json({ outcomes: sessionOutcomesDb.getUnseenOutcomes(userId, visiblePaths) });
  })
);

/**
 * ‏T-1340 — إقرارٌ عالمي برؤية نهاية/خطأ. السؤال لا يتأثر بالفتح.
 *
 * الجسم `{ expectedOutcomeAt }` هو نسخة CAS للحكم الذي رآه العميل. إن انتهت
 * جولة أحدث قبل وصول الطلب فلا يطابق التحديث شيئاً، فلا تختفي شارة لم يرها.
 *
 * ‏`204` **دائماً**، والكتابة تقع فقط إن كانت الجلسة مرئيةً للطالب: فلا يفرّق
 * المُنقِّب بين «غير موجودة» و«لا تراها». وهذا الفصل هو جوهر الإصلاح: فتحُ
 * المحادثة كان يحذف الحقيقة نفسها فتضيع عن بقية الأعضاء.
 */
router.post(
  '/:sessionId/outcome-seen',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const expectedOutcomeAt = parseExpectedOutcomeAt(req.body?.expectedOutcomeAt);
    const userId = readAuthenticatedUserId(req);
    if (userId) {
      try {
        assertSessionAccessible(sessionId, userId, 'read');
        if (expectedOutcomeAt) {
          sessionOutcomesDb.markOutcomeSeen(sessionId, expectedOutcomeAt);
        }
        // ابث الحقيقة الحالية حتى عند CAS mismatch: قد يكون العميل أخفى الحكم
        // القديم تفاؤلياً، بينما دلتا الحكم الأحدث سبقته ولم تعد في الطريق.
        // والعميل القديم بلا expectedOutcomeAt يأخذ 204 no-op مع نفس إعادة البث.
        notifyOutcomeChanged(sessionId);
      } catch {
        // مقصود: لا يُفرّق الردّ بين «لا تراها» و«غير موجودة».
      }
    }
    res.status(204).end();
  })
);

/**
 * ‏T-1340 — «تحديد كغير مقروء»: يُبطل الإقرار العالمي فتعود الشارة للجميع.
 *
 * يستطيع أي عضو مخوّل بالقراءة تنفيذ الفعل، وأثره مشترك بين كل الأعضاء.
 *
 * الردّ موحّد الشكل لكل الحالات (`{ outcome }`)، و`null` تعني «لا حكم» أو «لا
 * تراها» بلا تفريق — فلا يصلح مسبار وجود.
 */
router.delete(
  '/:sessionId/outcome-seen',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const userId = readAuthenticatedUserId(req);
    if (!userId) {
      res.json({ outcome: null, outcomeAt: null });
      return;
    }
    try {
      assertSessionAccessible(sessionId, userId, 'read');
      const row = sessionOutcomesDb.clearOutcomeSeen(sessionId);
      notifyOutcomeChanged(sessionId);
      res.json({ outcome: row?.outcome ?? null, outcomeAt: row?.outcomeAt ?? null });
    } catch {
      // مقصود: لا يُفرّق الردّ بين «لا تراها» و«غير موجودة».
      res.json({ outcome: null, outcomeAt: null });
    }
  })
);

export default router;
