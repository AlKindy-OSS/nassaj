import { Cog } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../../../auth';
import SettingsSection from '../SettingsSection';

import HarnessAutoUpdateSection from './agents-settings/sections/HarnessAutoUpdateSection';
import TmpfsCapSection from './TmpfsCapSection';
import StoragePolicySection from './StoragePolicySection';
import PermissionFencesSection from './PermissionFencesSection';

/**
 * T-1866 (owner-approved IA option B): «النظام» — تبويبٌ جديد يفصل ثلاث
 * مجموعاتٍ كانت مبعثرة: التحديث التلقائي (كان مُكرَّراً في كل صفحة وكيل)،
 * وسقف tmpfs/سياسة التخزين وحجوب الصلاحيات (كانت تحت «لوحة الأوامر» التي
 * تخصّها كتابعٍ لقيد الدور لا لموضوعها). «لوحة الأوامر» تبقى لموضوعها الحقيقي
 * وحده: صلاحية الأدوار وطبقة التنفيذ الخام والأوامر الآمنة/المخصَّصة.
 *
 * قيد الدور مطابقٌ لـ`CommandBoardSettingsTab`: بوّابة هنا (`return null`) وفي
 * `Settings.tsx` (شرط الرسم) وفي `settingsUrl.canOpenSettingsTab` (الروابط
 * العميقة) — الثلاثة معاً لا واحدة منها بمفردها.
 */
export default function SystemSettingsTab() {
  const { t } = useTranslation('settings');
  const { user } = useAuth();

  if (user?.role !== 'owner') return null;

  return (
    <SettingsSection
      level="page"
      icon={Cog}
      tone="info"
      title={t('systemSettings.title', { defaultValue: 'النظام' })}
      description={t('systemSettings.description', {
        defaultValue: 'التحديث التلقائي، وسقف التخزين، وحجوب الصلاحيات — إعدادات المالك على مستوى الخادم كله.',
      })}
    >
      <div className="space-y-8">
        <HarnessAutoUpdateSection viewerRole={user?.role} />
        <TmpfsCapSection />
        <StoragePolicySection />
        <PermissionFencesSection />
      </div>
    </SettingsSection>
  );
}
