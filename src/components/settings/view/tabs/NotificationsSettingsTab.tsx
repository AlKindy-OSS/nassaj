import { Bell, BellOff, BellRing, Loader2, Megaphone, Play, Radio } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import { playChatCompletionSound } from '../../../../utils/notificationSound';
import type { NotificationPreferencesState } from '../../types/types';
import SettingsCard from '../SettingsCard';
import SettingsGroup from '../SettingsGroup';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsToggle from '../SettingsToggle';
import StatusBadge from '../StatusBadge';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  pushPermission: NotificationPermission | 'unsupported';
  isPushSubscribed: boolean;
  isPushLoading: boolean;
  onEnablePush: () => void;
  onDisablePush: () => void;
};

/**
 * تبويب التنبيهات.
 *
 * كان **ثلاث بطاقات** بنفس الأصناف مرتَّبةً ثلاثة ترتيبات مختلفة، كلٌّ منها تحمل
 * رأسها الخاص. صار قسمين وقائمتَي صفوف: كل بطاقةٍ كانت رأساً وسطراً أو سطرين،
 * وعنوان القسم يؤدّي عمل الرأس والإطار معاً (‏§0 و§1 من الـBrief).
 *
 * وفعل «تجربة الصوت» بجانب مفتاحه في صفٍّ واحد لا في صفّ خاصّ به: هو تحقّقٌ من
 * الإعداد نفسه لا إعدادٌ ثانٍ.
 */
export default function NotificationsSettingsTab({
  notificationPreferences,
  onNotificationPreferencesChange,
  pushPermission,
  isPushSubscribed,
  isPushLoading,
  onEnablePush,
  onDisablePush,
}: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');

  const pushSupported = pushPermission !== 'unsupported';
  const pushDenied = pushPermission === 'denied';

  const setEvent = (key: keyof NotificationPreferencesState['events'], value: boolean) => {
    onNotificationPreferencesChange({
      ...notificationPreferences,
      events: { ...notificationPreferences.events, [key]: value },
    });
  };

  // سبب التعذّر يحلّ محلّ وصف الصفّ: هو ما يقول للمستخدم لماذا لا زرّ هنا.
  // وهو **تنبيهٌ لا يمنع الشاشة** — بيئةٌ أو إذنٌ يحجب قناةً واحدة — فيأخذ صندوق
  // نبرة `warning` بدل نصٍّ رمادي يمرّ دون أن يُقرأ (الأصل يؤطّر ما يخالف بقيّته).
  const pushBlockedReason = !pushSupported
    ? t('notifications.webPush.unsupported')
    : pushDenied
      ? t('notifications.webPush.denied')
      : null;

  return (
    <div className="space-y-8">
      <SettingsSection
        level="page"
        icon={Bell}
        tone="info"
        title={t('notifications.title')}
      >
        {pushBlockedReason && (
          <SettingsCard tone="warning">
            <p className="text-[13px] leading-relaxed text-warning">{pushBlockedReason}</p>
          </SettingsCard>
        )}

        {/* قسمٌ بعنوانه لا صفوفاً معلّقة تحت عنوان الصفحة: «قنوات» و«أنواع
            الأحداث» مستويان متكافئان، وكان الأول بلا عنوان ولا حدّ فيُقرأ تتمّةً
            لرأس الصفحة. ورأس الصفحة نفسه لا يُصندَق حتى لا تتداخل بطاقتان. */}
        <SettingsSection
          boxed
          icon={Megaphone}
          title={t('notifications.channels.title', { defaultValue: 'قنوات الإشعار' })}
        >
        <SettingsGroup>
          <SettingsRow label={t('notifications.webPush.title')}>
            {pushSupported && !pushDenied && (
              <div className="flex flex-wrap items-center justify-end gap-2">
                {/* اشتراكٌ قائم = نبرة `success` بنصّ الخريطة الدلالية (سماح/اتصال
                    قائم)، لا شارةً محايدة تُقرأ لصيقةً لا حالة. */}
                {isPushSubscribed && (
                  <StatusBadge tone="success">{t('notifications.webPush.enabled')}</StatusBadge>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant={isPushSubscribed ? 'destructive' : 'default'}
                  disabled={isPushLoading}
                  onClick={() => {
                    if (isPushSubscribed) {
                      onDisablePush();
                    } else {
                      onEnablePush();
                    }
                  }}
                >
                  {isPushLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : isPushSubscribed ? (
                    <BellOff className="h-4 w-4" />
                  ) : (
                    <BellRing className="h-4 w-4" />
                  )}
                  {isPushLoading
                    ? t('notifications.webPush.loading')
                    : isPushSubscribed
                      ? t('notifications.webPush.disable')
                      : t('notifications.webPush.enable')}
                </Button>
              </div>
            )}
          </SettingsRow>

          <SettingsRow
            label={t('notifications.sound.title')}
            description={t('notifications.sound.description')}
          >
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  void playChatCompletionSound({ force: true });
                }}
              >
                <Play className="h-4 w-4" />
                {t('notifications.sound.test')}
              </Button>
              <SettingsToggle
                checked={notificationPreferences.channels.sound}
                onChange={(value) =>
                  onNotificationPreferencesChange({
                    ...notificationPreferences,
                    channels: { ...notificationPreferences.channels, sound: value },
                  })
                }
                ariaLabel={t('notifications.sound.title')}
              />
            </div>
          </SettingsRow>
        </SettingsGroup>
        </SettingsSection>
      </SettingsSection>

      {/* الأحداث التي تُبثّ — `Radio` أيقونة بثٍّ لا زخرفة، ونبرة محايدة: القسم
          اختيارُ ما يُعلَن، لا سماحٌ ولا حاجز. */}
      <SettingsSection boxed icon={Radio} title={t('notifications.events.title')}>
        <SettingsGroup>
          <SettingsRow label={t('notifications.events.actionRequired')}>
            <SettingsToggle
              checked={notificationPreferences.events.actionRequired}
              onChange={(value) => setEvent('actionRequired', value)}
              ariaLabel={t('notifications.events.actionRequired')}
            />
          </SettingsRow>
          <SettingsRow label={t('notifications.events.stop')}>
            <SettingsToggle
              checked={notificationPreferences.events.stop}
              onChange={(value) => setEvent('stop', value)}
              ariaLabel={t('notifications.events.stop')}
            />
          </SettingsRow>
          <SettingsRow label={t('notifications.events.error')}>
            <SettingsToggle
              checked={notificationPreferences.events.error}
              onChange={(value) => setEvent('error', value)}
              ariaLabel={t('notifications.events.error')}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsSection>
    </div>
  );
}
