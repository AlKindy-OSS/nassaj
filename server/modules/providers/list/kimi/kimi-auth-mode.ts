/**
 * kimi-auth-mode.ts — اكتشاف وضع اتصال Kimi: اشتراك Kimi Code (OAuth)
 * مقابل مفتاح API. المساران مستقلان تماماً، ويمكن أن يتعايشا.
 *
 * الاشتراك يعيش في ملف اعتمادات CLI الأصيل: `~/.kimi-code/credentials/kimi-code.json`
 * للمشغّل، أو `~/.nassaj-users/<userId>/.kimi/credentials/kimi-code.json` للمستخدم
 * المعزول (لأن KIMI_CODE_HOME يُضبَط على `.kimi` في resolveProviderEnv).
 * التوكن صالح فقط إن بقي فيه أكثر من 60 ثانية قبل انتهائه — هكذا تتصرّف
 * أدوات الطرف الثالث (quota-axi).
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { credentialPrincipalId } from '@/services/isolation/credential-principal.js';
import { userConfigDir } from '@/services/isolation/provision-user-dirs.js';
import { resolveSlotKey } from '@/services/isolation/provider-slot-key.js';

/** أقل مهلة قبول لتوكن الاشتراك (بالثواني). */
const SUBSCRIPTION_MIN_VALIDITY_SEC = 60;

/**
 * مسار ملف اعتمادات الاشتراك لمستخدم بعينه.
 * ‏`userId = null` ⇒ جذر المشغّل `~/.kimi-code/`.
 * غير ذلك ⇒ جذر العزل `~/.nassaj-users/<userId>/.kimi/` (نفس ما يضبطه
 * resolveProviderEnv عند وضع agent).
 */
function subscriptionCredentialsPath(userId: string | number | null): string {
  if (userId === null || userId === undefined) {
    return path.join(os.homedir(), '.kimi-code', 'credentials', 'kimi-code.json');
  }
  // T-1675: the credential in use may be one delegated by another member.
  return path.join(userConfigDir(credentialPrincipalId(userId, 'kimi'), '.kimi'), 'credentials', 'kimi-code.json');
}

/**
 * هل يملك المستخدم اشتراك Kimi Code صالحاً؟
 * يقرأ الملف ويتحقق من `expires_at` — لا يجدّد التوكن.
 */
export async function hasValidKimiSubscription(
  userId: string | number | null,
): Promise<boolean> {
  try {
    const raw = await readFile(subscriptionCredentialsPath(userId), 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    const accessToken = typeof data.access_token === 'string' ? data.access_token : '';
    const expiresAt = typeof data.expires_at === 'number' ? data.expires_at : 0;
    if (!accessToken || !expiresAt) return false;

    const nowSec = Math.floor(Date.now() / 1000);
    return expiresAt - nowSec > SUBSCRIPTION_MIN_VALIDITY_SEC;
  } catch {
    return false;
  }
}

/**
 * وضع اتصال Kimi لمستخدم بعينه.
 * ‏`subscription_oauth` أولاً (هو الأساس في العرض)، ثم `api_key`، ثم `both`.
 */
export async function detectKimiAuthMode(
  userId: string | number | null,
): Promise<'api_key' | 'subscription_oauth' | 'both' | null> {
  // `sharedFallback: false` preserved: this reports how THIS member is connected,
  // and an org key is not a member's api_key credential.
  const hasKey = resolveSlotKey(credentialPrincipalId(userId, 'kimi'), 'kimi', { sharedFallback: false }) !== null;
  const hasSubscription = await hasValidKimiSubscription(userId ?? null);

  if (hasKey && hasSubscription) return 'both';
  if (hasSubscription) return 'subscription_oauth';
  if (hasKey) return 'api_key';
  return null;
}
