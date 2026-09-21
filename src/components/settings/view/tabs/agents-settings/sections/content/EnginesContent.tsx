import { Cpu, Lock } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import SettingsCard from '../../../../SettingsCard';
import SettingsGroup from '../../../../SettingsGroup';
import SettingsSection from '../../../../SettingsSection';
import StatusBadge from '../../../../StatusBadge';
import { useProviderApiKey } from '../../../../../../provider-auth/hooks/useProviderApiKey';
import { COMPANY_NAME, VENDORS, vendorForSlot } from '../../../../../../../../shared/vendors';
import {
  ENGINE_AXIS_HOST,
  ENGINE_AXIS_LABEL,
  actionableEngineCells,
  engineKeySlot,
  type BodyEngineCell,
  type BodyEngineStatus,
} from '../../../../../../../../shared/bodyEngineMatrix';
import type { LLMProvider } from '../../../../../../../types/app';
import type { AgentProvider } from '../../../../../types/types';

/**
 * EnginesContent — the ENGINE axis, rendered inside the body it belongs to.
 *
 * It replaces the top-level "Engines" tab. That tab was right about the axis and
 * wrong about the place: it listed engines as a flat catalogue with no body in
 * sight, next to an Agents tab that listed bodies with no engine in sight, so the
 * one question the two axes exist to answer — *what can THIS agent actually run
 * on?* — was asked by neither and had to be reassembled by the reader. Two tabs,
 * each holding half of one fact.
 *
 * The axes are still not merged; the ORDER of the questions is. You open an agent
 * (a body: its CLI, tools, permissions, sessions) and its engines are one of its
 * tabs, the way its permissions are. An engine is still not a body and never
 * appears in the agent bar — the confusion the 2026-07-26 fold removed does not
 * come back.
 *
 * Three rules this panel keeps, inherited from the surface it replaces:
 *
 *   1. It names the ENDPOINT each engine is really called on. Z.AI's own guide
 *      sells the opposite ("see a Claude model in the UI while GLM answers"); a
 *      tool whose whole job is knowing which vendor ran your prompt may never be
 *      coy about it.
 *   2. It claims only what the key store can back — "a key is stored", never
 *      "connected". Whether a key is valid is known only from a run.
 *   3. It shows a cell's EVIDENCE (ADR-073): measured on this machine, or merely
 *      inferred from a vendor's documentation. A pair that has never been run is
 *      labelled unverified rather than quietly rendered like one that has.
 *
 * SCOPE — this panel adds no capability. It states the matrix and stores keys,
 * exactly as the tab it replaces did. Choosing an engine for a run still happens
 * only in the chat model picker, and still only for bodies that already had it.
 * ADR-073 §4 forbids launching a non-Claude body on a custom engine before that
 * body's config guard exists, and nothing here crosses that line.
 */
export default function EnginesContent({ agent }: { agent: AgentProvider }) {
  const { t } = useTranslation('settings');
  const cells = actionableEngineCells(agent);

  /**
   * **الفئة تظهر لكلّ وكيل، وجوابُها لمن لا بديلَ له معلومةٌ لا فراغ** (‏T-1232،
   * شكوى المالك 2026-08-04: «بعض الوكلاء فيهم تبويب المحرّكات وبعضهم لا، ليش هذي
   * الفوضى؟»).
   *
   * والغيابُ لم يكن عشوائياً: `actionableEngineCells` تُرجع فارغاً لمن لا محرّك
   * بديلَ له (‏codex، gemini، cursor، antigravity، hermes)، فكان التبويب يُخفى
   * كي لا يفتح على بياض. لكن «لا تبويب» تُقرأ نقصاً في المنتج لا حقيقةً عن
   * الوكيل — والقاعدة الصحيحة مطبَّقةٌ في هذا المشروع منذ ADR-093 §2 على تبويب
   * «التعليمات»: **لكل جسمٍ جوابٌ عن هذا السؤال، حتى الذي جوابه «لا قناة»**.
   *
   * فالجواب هنا: هذا الوكيل يعمل على محرّكه وحده. وهي معلومةٌ يحتاجها من يسأل
   * «أستطيع تشغيل Codex على GLM؟» — والصمتُ يتركه يبحث.
   */
  if (cells.length === 0) {
    return (
      <SettingsSection
        icon={Cpu}
        title={t('engines.title', { defaultValue: 'Engines' })}
      >
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t('engines.noAlternative', {
            defaultValue: 'This agent runs on its own engine only — there is nothing to switch.',
          })}
        </p>
      </SettingsSection>
    );
  }

  return (
    // الرأس كان مبنيّاً بيدٍ (`h3.text-base` + فقرة) فخرج بمقاسٍ أصغر من رؤوس
    // الأقسام حوله ومن غير أيقونة تسبقه. البدائية تعطيه سلّمه وأيقونته معاً:
    // `Cpu` لأن المحرّك هو ما يولّد التوكنات فعلاً — لا الجسم ولا الاعتماد.
    <SettingsSection
      icon={Cpu}
      // ‏`boxed` — قائمة المحرّكات صفوفٌ متعدّدة بلا فواصل، فالحدّ هو ما يقول أين
      // تبدأ القائمة وأين تنتهي. صندوقٌ واحد حول الكلّ، لا صندوقٌ لكل محرّك.
      boxed
      title={t('engines.title', { defaultValue: 'Engines' })}
      description={(
        <>
          {t('engines.description', {
            defaultValue:
              'An engine is the endpoint that generates the tokens. The agent system (body) — its tools, permissions and sessions — stays exactly the same; only the model provider behind it changes.',
          })}
          <EngineSwitchHint agent={agent} />
        </>
      )}
    >
      {/* صفوفٌ بفواصل شعرية لا بطاقةً لكل محرّك (§1): خمسة صناديق متجاورة تحت
          عنوانٍ يجمّعها أصلاً هي عين ما أسقطته النسخة السابقة. */}
      <SettingsGroup>
        {cells.map((cell) => (
          <EngineRow key={`${agent}-${cell.engine}`} body={agent} cell={cell} />
        ))}
      </SettingsGroup>

      <DelegateToolNote agent={agent} />
    </SettingsSection>
  );
}

/**
 * ‏`delegate_to_vendor` — **ليست محرّكاً ولا حساباً** (T-1206).
 *
 * الأداة تصرف مفتاح Moonshot وZ.AI وDeepSeek على كل إطلاق Claude
 * (‏`vendor-delegate-mcp.js`)، وهذه حقيقةٌ لا يجوز أن تختفي: لأجلها كُتب المحور
 * `tool` أصلاً حين كان سطر «يُستهلك في» يُنقص ثلاثة قرّاء (B-363). لكنها ليست
 * تهيئةَ تشغيل — لا جسمٌ ولا نقطةُ طرف — فلا صفَّ لها في مصفوفة المحرّكات ولا
 * بطاقةَ اعتمادٍ لها في حساب Claude.
 *
 * فتُقال **مرّةً واحدة**، سطراً أسفل المحرّكات: مَن تصرف مفاتيحهم، وأين تُضبط،
 * وكيف تُطفأ. بلا حقل إدخال، لأن المفتاح ملكُ شركته وحقلُه في بطاقتها.
 */
function DelegateToolNote({ agent }: { agent: AgentProvider }) {
  const { t } = useTranslation('settings');

  // مشتقّة من الكتالوج لا مكتوبةً بيد: مورّدٌ جديد تصرفه الأداة يظهر هنا بمجرّد
  // إعلان مستهلكه، ولا يحتاج تعديل هذه الجملة.
  const companies: string[] = [];
  for (const vendor of VENDORS) {
    if (!vendor.consumers.some((consumer) => consumer.axis === 'tool' && consumer.body === agent)) {
      continue;
    }
    const name = COMPANY_NAME[vendor.companyId] ?? vendor.name;
    if (!companies.includes(name)) companies.push(name);
  }
  if (companies.length === 0) return null;

  return (
    // نبرة `info` لا `warning`: إخبارٌ عن قدرةٍ قائمة، ولا فعلَ مطلوباً من القارئ.
    <SettingsCard tone="info" className="mt-4">
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        {t('engines.delegateTool', {
          vendors: companies.join(t('vendors.listSeparator', { defaultValue: ' · ' })),
          defaultValue:
            'The delegate_to_vendor tool lets this agent hand a subtask to {{vendors}} using their '
            + 'stored keys. Each key is managed from that company’s own account, and the tool itself '
            + 'is switched off from the MCP servers tab.',
        })}
      </p>
    </SettingsCard>
  );
}

/**
 * Where the switch is actually made, for the bodies where it is user-reachable
 * today. Silent for the rest: inventing a "how to" for a path that does not
 * exist is the same lie as a green badge on an untested one.
 */
function EngineSwitchHint({ agent }: { agent: AgentProvider }) {
  const { t } = useTranslation('settings');

  // `span.block` لا `p`: هذا النصّ يعيش الآن داخل وصف `SettingsSection` وهو
  // فقرةٌ بذاته — وفقرةٌ داخل فقرة تُبطلها المتصفّحات وتكسر التداخل.
  if (agent === 'claude') {
    return (
      <span className="mt-2 block text-[13px] leading-relaxed text-muted-foreground">
        {t('engines.usageHint', {
          defaultValue:
            'Once a key is stored, pick "Claude engine on <engine>" from the model picker in a chat. The chat shows which engine it is running on.',
        })}
      </span>
    );
  }

  if (agent === 'opencode') {
    return (
      <span className="mt-2 block text-[13px] leading-relaxed text-muted-foreground">
        {t('engines.usageHintOpenCode', {
          defaultValue:
            'Once a key is stored, pick the engine\'s model (for example a "glm/…" entry) from the model picker in a chat.',
        })}
      </span>
    );
  }

  return null;
}

/**
 * نبرة الشارة — **ثلاث لا ثمان** (`SETTINGS-SURFACE-LANGUAGE.md` §2.5).
 *
 * كانت هنا لوحةٌ من خمس عائلات خامّة (green/teal/amber/blue) لثمانِ حالات، ثم
 * سُوّيت كلّها إلى المحايد لأن الرموز `--success`/`--warning` لم تكن موجودة في
 * `src/index.css` فكانت كل نبرة ثالثة لوناً خارج النظام. الرموز موجودة الآن
 * ومحروسة باختبار تباين، والتسوية الكاملة صارت هي المشكلة: على قائمةٍ من خمسة
 * صفوف كان «يعمل اليوم» و«لم يُقَس» يخرجان بنفس السطح تماماً.
 *
 * والخريطة **ثلاث درجات لا ثمان** — القارئ لا يحفظ ثمانياً:
 *
 *   `success` — يعمل: محرّكه الأصيل، أو مقيسٌ اليوم، أو جاهزٌ باعتمادٍ مخزَّن.
 *   `warning` — الاعتماد وحده هو الحائل: شيءٌ يستطيع القارئ رفعه.
 *   `neutral` — توصيفُ قدرةٍ لا فعلَ للقارئ فيه: لم نصله بعد، أو المورّد لا
 *               يقدّمه، أو لم يُقَس. ولا `danger` هنا البتّة: `danger` محجوزة
 *               للمنع والحذف ورفع الحاجز الأمني، وليس منها شيءٌ في هذه اللوحة.
 *
 * والنقطة الدالّة في `StatusBadge` تحمل التمييز مع النصّ فلا يقع على اللون
 * وحده (‏WCAG 1.4.1).
 */
const ROW_STATUS_TONE: Record<RowStatus, 'neutral' | 'success' | 'warning'> = {
  native: 'success',
  available: 'success',
  ready: 'success',
  blocked_by_owner: 'warning',
  needs_credential: 'warning',
  blocked_by_us: 'neutral',
  closed_at_vendor: 'neutral',
  unverified: 'neutral',
  // B-415/م-1 — «ينقصه مفتاح» على زوجٍ لا موضعَ لمفتاحه (`engineKeySlot` = null):
  // الحاجز شراءٌ حقيقي، لكن لا حقلَ في نسّاج يستقبل ما يُشترى، فليس **شيئاً
  // يستطيع القارئ رفعه** — وهو تعريف `warning` أعلاه حرفياً. سبع خلايا كانت تعد
  // بحاجزٍ قابل للرفع ولا تقول أين يُرفع؛ والنبرة المحايدة هي الصدق الوحيد
  // المتاح قبل أن يُقاس موضعٌ يقبل هذا المفتاح فعلاً.
  blocked_unplaced: 'neutral',
};

/**
 * What the row displays — the declared cell status, RESOLVED against the live
 * credential. Two extra values exist only here because they are not properties
 * of the matrix: they are what the matrix becomes once you know whether the key
 * is present.
 */
type RowStatus = BodyEngineStatus | 'ready' | 'needs_credential' | 'blocked_unplaced';

/**
 * Resolve the declared status against the credential we can actually see.
 *
 * WHY THIS EXISTS (B-349). The matrix is static by design — "z.ai has no Responses API"
 * is a fact about someone else's server and cannot be computed. But
 * `blocked_by_owner` does not mean "blocked" — it means *the only thing left is
 * a purchase*. Once the key is stored that sentence is false, and the row was
 * still printing "Needs a key · all that is missing is a Moonshot key" directly
 * above a line reading "Moonshot credential is stored". Two indicators for one
 * fact will always drift apart; the fix is not to sync them, it is to have one.
 *
 * Note what is NOT claimed: a stored credential does not promote a cell to
 * `available` (= runs today, measured). Evidence is a separate axis, and paying
 * for a key proves nothing about the endpoint. The honest state is `ready`.
 */
/*
 * Exported for the test only (B-375). Claude × Kimi used to be the one rendered
 * pair that reached `ready`, so the mapping was asserted through the panel. That
 * pair is `available` now, and no declared cell with a key slot is
 * `blocked_by_owner` today — the rule outlives its last example, so it is pinned
 * where it lives instead of through whichever row happens to illustrate it.
 */
export function resolveRowStatus(
  declared: BodyEngineStatus,
  credential: 'none' | 'loading' | 'stored' | 'missing',
  /**
   * هل لهذا الزوج موضعُ مفتاحٍ يُكتب فيه أصلاً (`engineKeySlot` ≠ null)؟
   *
   * ‏B-415/م-1 — `blocked_by_owner` تعني «لم يبقَ إلا الشراء»، وهي على زوجٍ بلا
   * موضعٍ نصفُ جملة: القارئ يشتري ثم لا يجد حقلاً. فالحالة تُفصَل باسمها بدل أن
   * تُصبغ إنذاراً يعِد بفعلٍ لا سبيل إليه. الافتراضي `true` كي لا يتغيّر معنى أي
   * نداءٍ قائم.
   */
  hasSlot: boolean = true,
): RowStatus {
  if (declared === 'blocked_by_owner' && !hasSlot) {
    return 'blocked_unplaced';
  }
  if (credential === 'none' || credential === 'loading') {
    return declared;
  }
  if (credential === 'stored' && declared === 'blocked_by_owner') {
    return 'ready';
  }
  if (credential === 'missing' && (declared === 'available' || declared === 'blocked_by_owner')) {
    return 'needs_credential';
  }
  return declared;
}

/** A row whose pair reads a credential slot: resolve the status against it. */
function EngineRowWithCredential({
  body,
  cell,
  slot,
}: {
  body: AgentProvider;
  cell: BodyEngineCell;
  slot: { provider: string; target?: string };
}) {
  const { configured, loading } = useProviderApiKey(slot.provider as LLMProvider, slot.target);
  const vendor = vendorForSlot(slot.provider, slot.target);

  return (
    <EngineRowView
      body={body}
      cell={cell}
      credential={loading ? 'loading' : configured ? 'stored' : 'missing'}
      vendorName={vendor?.name ?? slot.provider}
      hasSlot
    />
  );
}

function EngineRow({ body, cell }: { body: AgentProvider; cell: BodyEngineCell }) {
  // ADR-085: this panel STATES capability and never collects a secret. A
  // credential belongs to the vendor that issues and bills it, not to the pair
  // that spends it — one Moonshot key is read by the Kimi agent and by the Kimi
  // engine under Claude. An input here would be a second writer for one record,
  // and on a pair whose body reads a different file it is exactly how B-343
  // shipped: a key stored, reported configured, and read by nothing.
  const slot = engineKeySlot(body, cell.engine);

  // A separate component (not a conditional hook): only a pair with a slot has a
  // credential to look up, and `blocked_by_us` / `closed_at_vendor` must not
  // query one — their barrier is not a key, so asking would invite the operator
  // to buy one that changes nothing.
  if (slot && (cell.status === 'available' || cell.status === 'blocked_by_owner')) {
    return (
      <EngineRowWithCredential body={body} cell={cell} slot={slot} />
    );
  }

  return (
    <EngineRowView
      body={body}
      cell={cell}
      credential="none"
      vendorName={null}
      // ‏`hasSlot={false}` هنا حرفياً هو ما يمنع «ينقصه مفتاح» الكهرمانية على زوجٍ
      // لا حقلَ له: هذا الفرع هو فرع «لا موضع» بعينه.
      hasSlot={Boolean(slot)}
    />
  );
}

function EngineRowView({
  cell,
  credential,
  vendorName,
  hasSlot,
}: {
  body: AgentProvider;
  cell: BodyEngineCell;
  credential: 'none' | 'loading' | 'stored' | 'missing';
  vendorName: string | null;
  /** هل يقرأ هذا الزوج موضعَ مفتاحٍ قابلاً للكتابة (‏`engineKeySlot`)؟ */
  hasSlot: boolean;
}) {
  const { t } = useTranslation('settings');
  const name = ENGINE_AXIS_LABEL[cell.engine];
  const host = ENGINE_AXIS_HOST[cell.engine];
  const status = resolveRowStatus(cell.status, credential, hasSlot);
  const vendor = vendorName ?? name;

  const statusLabel = status === 'ready'
    ? t('engines.status.ready', { defaultValue: 'Ready — not measured here' })
    : status === 'needs_credential'
      ? t('engines.status.needsCredential', {
        vendor,
        defaultValue: 'Needs a {{vendor}} credential',
      })
      : status === 'blocked_unplaced'
        ? t('engines.status.blockedUnplaced', {
          defaultValue: 'Needs a key — no field for it here yet',
        })
        : t(`engines.status.${status}`, {
        defaultValue: {
          native: 'Its own engine',
          available: 'Runs today',
          blocked_by_owner: 'Needs a key',
          blocked_by_us: 'Not landed yet',
          closed_at_vendor: 'Not offered by the vendor',
          unverified: 'Unverified',
        }[status as BodyEngineStatus],
      });

  const evidenceLabel = cell.evidence === 'none'
    ? null
    : t(`engines.evidence.${cell.evidence}`, {
      defaultValue: cell.evidence === 'measured' ? 'measured' : 'inferred',
    });

  // The declared sentence explains a barrier. Once the barrier is gone it is no
  // longer true of this install, so the resolved state supplies its own.
  const note = status === 'ready'
    ? t('engines.readyNote', {
      vendor,
      defaultValue:
        'The {{vendor}} credential is stored, so nothing blocks this pair — it just has not been run from nassaj yet.',
    })
    : t(`engines.cell.${cell.note}`, { defaultValue: cell.noteDefault });

  return (
    <div className="py-3.5">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-foreground">{name}</span>
        {host && (
          <span
            dir="ltr"
            style={{ unicodeBidi: 'isolate' }}
            className="font-mono text-[13px] text-muted-foreground"
            title={t('engines.endpointLabel', {
              defaultValue: 'Endpoint this engine is called on',
            })}
          >
            {host}
          </span>
        )}
        {/* الدليل نصٌّ خافت لا شارة: لا يُنافس الحالةَ على الانتباه، ولا يضيف
            سطحاً ثانياً بجوار الشارة (v2 §1). */}
        {evidenceLabel && (
          <span className="text-[13px] leading-none text-muted-foreground">{evidenceLabel}</span>
        )}
        <StatusBadge tone={ROW_STATUS_TONE[status]} className="ms-auto">{statusLabel}</StatusBadge>
      </div>

      <p className="text-[13px] leading-relaxed text-muted-foreground">{note}</p>

      {/*
        The pointer appears ONLY when a missing credential is the barrier. When
        the key is already stored, repeating "stored · managed in Vendors" under
        a badge that already says so is the duplication the operator noticed —
        and duplication is how the two indicators contradicted each other in the
        first place.
      */}
      {/* T-1147 — this sentence names a destination, so it must BE one: as plain
          text it told the user where to go and left them to find it.

          T-1206 pointed it at the OWNING agent's Account tab, because that is
          where the card was drawn. T-1219 moved every key input into one tab, so
          the sentence names that tab — and goes back to being plain text, on
          purpose. The jump is a MAIN-TAB switch, which this panel has no route
          for; a button that cannot navigate is the broken promise T-1147 was
          written to remove, and naming the one place there is costs the reader
          nothing to find. */}
      {status === 'needs_credential' && (
        <p className="mt-2 flex items-center gap-1.5 text-[13px] leading-relaxed text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {t('engines.managedInVendors', {
            defaultValue: 'Managed in Settings → Vendors & credentials',
          })}
        </p>
      )}
    </div>
  );
}
