import type { ReactNode } from 'react';

type QuickSettingsSectionProps = {
  title: ReactNode;
  children: ReactNode;
  className?: string;
};

export default function QuickSettingsSection({
  title,
  children,
  className = '',
}: QuickSettingsSectionProps) {
  return (
    <div className={`space-y-2 ${className}`}>
      {/* لا `uppercase` ولا `tracking-*` ولا `text-xs`: نمط eyebrow اللاتيني على نصّ
          عربي متصل خطٌّ أحمر (‏STYLE_LOCK §1، جذر B-329) — نفس تصحيح
          `SettingsSection`، فاللوحة السريعة لا تبقى نظاماً ثانياً. */}
      <h4 className="mb-2 text-sm font-semibold text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}
