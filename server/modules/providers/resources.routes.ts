/**
 * Resource routes (mounted at /api/providers/resources by provider.routes.ts).
 *
 *   GET /resources/session/:sessionId  → ما تستهلكه شجرة عمليات هذه المحادثة
 *
 * البوابة نفسها التي تحرس كلفة المحادثة (`assertSessionAccessible`): استهلاك
 * المحادثة صفةٌ لها، فمن لا يقرأ المحادثة لا يقيس مواردها. والرفض يجيب 404 لا
 * 403، كي لا يصير المسار عرّافاً يكشف وجود معرّفات جلسات.
 *
 * حالة **الجهاز** ليست هنا عمداً: هي ليست ملك محادثة، فمكانها ذيل الشريط
 * الجانبي مع بقيّة تلمترية المضيف (`GET /api/system/stats`). خلط المقياسين في
 * شارة واحدة يجعل رقم الجهاز يُقرأ رقمَ المحادثة.
 *
 * الغلاف مسطّح (`{ success, resources }`) اتّباعاً لعقد مسارات الكلفة المجاورة
 * لا للغلاف العام `{ success, data }`.
 */

import express, { type Request, type Response } from 'express';

import { assertSessionAccessible } from '@/modules/providers/services/sessions.service.js';
import { getSessionResourcesCached } from '@/modules/providers/services/session-resources.service.js';
import { AppError, asyncHandler } from '@/shared/utils.js';

const router = express.Router();

// حدّ المعدّل يُركَّب عند نقطة الوصل في `server/index.js` لا هنا: طبقة الوحدة
// لا يُسمح لها باستيراد `middleware/*` (حدود المعمارية)، وهو أيضاً الموضع
// الذي تُركَّب فيه بقيّة حدود المعدّل. والكاش في الخدمة يمتصّ التكرار أصلاً،
// فالحدّ دفاعٌ ثانٍ لا أوّل.

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

function parseSessionId(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!SESSION_ID_PATTERN.test(raw)) {
    throw new AppError('Invalid sessionId.', { code: 'INVALID_SESSION_ID', statusCode: 400 });
  }
  return raw;
}

/**
 * هوية المتصل من `req.user` وحده (يملؤها authenticateToken عند نقطة التركيب) —
 * لا من مدخلات الطلب. تفشل مغلقةً: هوية غير محلولة تُرفض قبل أي قياس.
 */
function readAuthenticatedUserId(req: Request): number {
  const rawId = (req as Request & { user?: { id?: number | string } }).user?.id;
  const userId =
    typeof rawId === 'number'
      ? rawId
      : typeof rawId === 'string' && rawId.trim() !== ''
        ? Number.parseInt(rawId, 10)
        : NaN;

  if (!Number.isInteger(userId)) {
    throw new AppError('Authentication required.', { code: 'AUTH_REQUIRED', statusCode: 401 });
  }
  return userId;
}

router.get(
  '/session/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const userId = readAuthenticatedUserId(req);

    assertSessionAccessible(sessionId, userId, 'read');

    res.json({ success: true, resources: getSessionResourcesCached(sessionId) });
  }),
);

export default router;
