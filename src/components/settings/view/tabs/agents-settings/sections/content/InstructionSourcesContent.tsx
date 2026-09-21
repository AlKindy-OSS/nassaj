import { useState } from 'react';
import { FileX, ScrollText, ShieldAlert, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../../../../shared/view/ui';
import { authenticatedFetch } from '../../../../../../../utils/api';
import { useProviderGovernance } from '../../../../../../chat/hooks/useProviderGovernance';
import type { GovernanceChannel } from '../../../../../../chat/hooks/useProviderGovernance';
import type { LLMProvider } from '../../../../../../../types/app';
import SettingsGroup from '../../../../SettingsGroup';
import SettingsRow from '../../../../SettingsRow';
import SettingsSection from '../../../../SettingsSection';
import StatusBadge from '../../../../StatusBadge';
import type { AgentProvider } from '../../../../../types/types';

/**
 * «من أين يأخذ هذا الوكيل تعليماته» — ADR-093 §2 (المرحلة أ، T-1195).
 *
 * لوحٌ قارئ محض: يعرض ما تشهد به الخدمة عن القرص لحظةَ القراءة، بلا زرّ ولا
 * إصلاح ولا وعد. ثلاثة مبادئ تحكم نصّه:
 *
 *  1. **لا تجميل** (§2.4): «غير محكوم» يُقال صراحةً ومعه سببه، ومحرّكٌ بلا آلية
 *     يُقال عنه «لا قناة تعليمات لهذا المحرّك» لا شارةٌ رمادية غامضة.
 *  2. **«محكوم» ليست كلمة واحدة** (§2.3-2): قناةٌ تحقُّقُها حضورٌ فقط — كلود —
 *     تُعرَض «حاضر بلا تحقّق هوية»، لأن الفحص لا يميّز تعليمات نسّاج من أي نصّ.
 *  3. **كون القناة رابطاً حقيقةٌ أمنية لا تفصيل تجميلي** (§1.2/§6-3): هدف الرابط
 *     يُعرَض دائماً.
 *  4. **زرّ الربط (§4، T-1197) لا يَعِد** ولا يظهر معطَّلاً: الخادم وحده يقرّر
 *     ‏`linkable`، وحين يرفض تُعرَض جملةُ سببه لا زرٌّ لا يعمل (§4.4). وبعد
 *     الضغط لا تُكتب «تمّ» من ذاكرة العميل — يُعاد جلب الواصف فيقول القرصُ حاله.
 *
 * ‏fail-HIDDEN كالشارة: خادمٌ أقدم من T-1195 (لا `sources`)، أو خطأ شبكة، أو
 * ‏404 ⇒ لا يُرسم اللوح إطلاقاً — غيابُ الجواب إخفاءٌ لا حكم.
 */

/** نصّ تقني (مسار) داخل واجهة عربية: عزل ثنائي الاتجاه + أحادي المسافة. */
function TechnicalPath({ value }: { value: string }) {
  return (
    <span
      dir="ltr"
      style={{ unicodeBidi: 'isolate' }}
      className="block break-all font-mono text-[13px] leading-relaxed text-foreground"
    >
      {value}
    </span>
  );
}

/** نبرة درجة الفرض بالرموز حصراً — لا عائلة لون خامّة ولا `dark:` للنبرة. */
const ENFORCEMENT_TONE: Record<GovernanceChannel['enforcement'], string> = {
  'fail-closed': 'text-success',
  'best-effort': 'text-warning',
  informational: 'text-muted-foreground',
  none: 'text-muted-foreground',
};

type ChannelPanelProps = {
  channel: GovernanceChannel;
  agent: AgentProvider;
  /** يُنادى بعد كتابة ناجحة ليُعاد قراءة الواصف من القرص. */
  onLinked: () => void;
};

function ChannelPanel({ channel, agent, onLinked }: ChannelPanelProps) {
  const { t } = useTranslation('settings');
  const base = 'agents.instructionSources';
  const isPresenceOnly = channel.verification === 'presence';
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [rechecked, setRechecked] = useState(false);

  const link = async (): Promise<void> => {
    setPending(true);
    setFailed(false);
    setRechecked(false);
    try {
      const response = await authenticatedFetch(`/api/providers/${agent}/governance/link`, {
        method: 'POST',
      });
      if (!response.ok) {
        setFailed(true);
        return;
      }
      // لا حكم من هنا: الحكم يأتي من إعادة القراءة، لا من نجاح الطلب.
      setRechecked(true);
      onLinked();
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };

  // محرّك بلا آلية: جملة صريحة، لا صفوف فارغة تُوهم بوجود قناة.
  // ‏`FileX` بنبرةٍ محايدة: غيابُ القناة ليس عطلاً ولا خطراً — هو حدّ المحرّك،
  // ولا فعلَ للقارئ فيه، فصبغُه إنذاراً يعِد بإصلاحٍ لا وجود له.
  if (channel.mechanism === 'none') {
    return (
      <SettingsSection icon={FileX} title={t(`${base}.noChannelTitle`)}>
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          {t(`${base}.reason.no_mechanism`)}
        </p>
      </SettingsSection>
    );
  }

  const verdictLabel =
    channel.status === 'governed'
      ? isPresenceOnly
        ? t(`${base}.verdict.presentUnverified`)
        : t(`${base}.verdict.governed`)
      : t(`${base}.verdict.ungoverned`);

  // الأيقونة تقول الحكم قبل قراءة العنوان، وشكلُها يقوله مع لونها: درعٌ مصدَّق
  // لقناةٍ محكومة متحقَّقة، ودرعٌ بعلامة تنبيه لقناةٍ تحقُّقُها حضورٌ فقط (الفحص
  // لا يميّز تعليمات نسّاج من أي نصّ)، ودرعٌ مطفأ لقناةٍ غير محكومة — وهي نبرة
  // `danger` لأن الحاجز التعليمي مرفوع فعلاً، وهو ما تحجز له الخريطة `danger`.
  return (
    <SettingsSection
      icon={
        channel.status !== 'governed' ? ShieldOff : isPresenceOnly ? ShieldAlert : ShieldCheck
      }
      tone={channel.status !== 'governed' ? 'danger' : isPresenceOnly ? 'warning' : 'success'}
      title={t(`${base}.channel.${channel.scope}`)}
      description={t(`${base}.mechanism.${channel.mechanism}`)}
      // القناة تجمع خمسة صفوف (حكم، مسار، هدف الرابط، تحقّق، فرض) وقد يليها
      // صفُّ الربط — فحدُّها مرسومٌ لا مُستنتَج، وإلا سالت قناةٌ في تاليتها حين
      // يعرض وكيلٌ قناتين (agy). والقسم الأب يبقى بلا صندوق فلا تتداخل بطاقتان.
      boxed
    >
      <SettingsGroup>
        <SettingsRow
          label={t(`${base}.field.verdict`)}
          description={channel.reason ? t(`${base}.reason.${channel.reason}`) : undefined}
        >
          <StatusBadge tone={channel.status === 'governed' ? 'neutral' : 'danger'}>
            {verdictLabel}
          </StatusBadge>
        </SettingsRow>

        <SettingsRow label={t(`${base}.field.path`)} stacked>
          {channel.path ? (
            <TechnicalPath value={channel.path} />
          ) : (
            <span className="text-[13px] leading-relaxed text-muted-foreground">
              {t(`${base}.field.noPath`)}
            </span>
          )}
        </SettingsRow>

        {channel.link && (
          <SettingsRow
            label={t(`${base}.field.link`)}
            description={t(`${base}.field.linkNote`)}
            stacked
          >
            <TechnicalPath value={channel.link} />
          </SettingsRow>
        )}

        <SettingsRow label={t(`${base}.field.verification`)}>
          <span className="text-[13px] leading-relaxed text-muted-foreground">
            {t(`${base}.verification.${channel.verification}`)}
          </span>
        </SettingsRow>

        <SettingsRow label={t(`${base}.field.enforcement`)}>
          <span className={`text-[13px] leading-relaxed ${ENFORCEMENT_TONE[channel.enforcement]}`}>
            {t(`${base}.enforcement.${channel.enforcement}`)}
          </span>
        </SettingsRow>

        {/* ‏§4.4: زرٌّ يعمل، أو جملةٌ تشرح لماذا لا زرّ — لا زرَّ معطَّلاً بينهما.
            ‏`no_mechanism` مستثناة لأن سطر «الحكم» قالها بالفعل. */}
        {channel.linkable ? (
          <SettingsRow
            label={t(`${base}.link.label`)}
            description={
              channel.linkScope === 'operator'
                ? t(`${base}.link.operatorNote`)
                : t(`${base}.link.userNote`)
            }
          >
            <div className="space-y-1.5">
              <Button type="button" size="sm" onClick={link} disabled={pending}>
                {pending ? t(`${base}.link.pending`) : t(`${base}.link.button`)}
              </Button>
              {rechecked && !failed && (
                <p className="text-[13px] leading-relaxed text-muted-foreground">
                  {t(`${base}.link.rechecked`)}
                </p>
              )}
              {failed && (
                <p className="text-[13px] leading-relaxed text-danger">
                  {t(`${base}.link.failed`)}
                </p>
              )}
            </div>
          </SettingsRow>
        ) : (
          channel.linkRefusal
          && channel.linkRefusal !== 'no_mechanism' && (
            <SettingsRow label={t(`${base}.link.label`)} stacked>
              <p className="text-[13px] leading-relaxed text-muted-foreground">
                {t(`${base}.linkRefusal.${channel.linkRefusal}`)}
              </p>
            </SettingsRow>
          )
        )}
      </SettingsGroup>
    </SettingsSection>
  );
}

export default function InstructionSourcesContent({
  agent,
  standalone = false,
}: {
  agent: AgentProvider;
  /**
   * ‏`true` حين يكون هذا اللوح **محتوى تبويبٍ كامل** لا كتلةً داخل تبويبٍ آخر.
   *
   * الفارق واحد: عقد fail-HIDDEN. كتلةٌ داخل تبويبٍ آخر تختفي كلّها حين لا يُجيب
   * الخادم بقنوات — وذلك صحيح، لأن ما حولها يملأ الشاشة. أما تبويبٌ يختفي محتواه
   * كلّه فيصير لوحاً أبيض بلا سببٍ معلن. فهنا يبقى **الرأس** (العنوان والوصف)
   * ظاهراً دائماً، وتغيب القنوات وحدها.
   *
   * ولا يُكتب مكانها «تعذّرت القراءة» عمداً: الخطّاف لا يفرّق بين «ما زال يقرأ»
   * و«فشل»، فأي جملةٍ هنا ستُعرَض أثناء التحميل ثم تختفي — أي وعدٌ لا يُثبته
   * الكود، وهو بعينه ما تحظره §2.4.
   */
  standalone?: boolean;
}) {
  const { t } = useTranslation('settings');
  // يُزاد بعد كل ربط ناجح فيُعاد جلب الواصف — الحكم المعروض من القرص لا من الذاكرة.
  const [refreshToken, setRefreshToken] = useState(0);
  const descriptor = useProviderGovernance(agent as LLMProvider, refreshToken);
  const channels = descriptor?.sources ?? [];

  if (channels.length === 0 && !standalone) {
    return null;
  }

  return (
    <div className={standalone ? 'space-y-5' : 'space-y-5 pt-6'}>
      <SettingsSection
        icon={ScrollText}
        // ‏`section` **في الحالتين** — كان `standalone ? 'page' : 'section'`.
        //
        // ‏`page` مقاسُ عنوان التبويب، وعنوان تبويب الوكلاء مرسومٌ فوق هذا اللوح
        // في `AgentsSettingsTab` أصلاً؛ فكان `text-2xl` يظهر مرّتين في شاشة واحدة
        // ويسقط ما يقول أيّهما يحتوي الآخر — وهو عين العطل الذي وُجد سلّمُ
        // المستويات لعلاجه. و«لوحُ فئةٍ داخل تبويب» ليس صفحةً مهما كان قائماً
        // بذاته: `standalone` يقرّر عقد fail-HIDDEN لا مقاس العنوان.
        level="section"
        title={t('agents.instructionSources.title')}
        description={t('agents.instructionSources.description')}
      >
        <div className="space-y-5">
          {channels.map((channel) => (
            <ChannelPanel
              key={channel.id}
              channel={channel}
              agent={agent}
              onLinked={() => setRefreshToken((token) => token + 1)}
            />
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
