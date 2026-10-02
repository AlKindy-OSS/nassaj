import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import SegmentedControl from '../../SegmentedControl';

import { MAX_ROLE_RULES } from './ssoModel';
import { TECH_INPUT_CLASS } from './ssoUi';
import type { SsoLocalRole, SsoRoleRule } from './ssoTypes';

/**
 * Role rules (brief §5 step 3): a value in the identity provider's role claim
 * maps to Admin or Member here. Owner is never offered (ADR-194 D4).
 */
export default function RoleRulesTable({ rules, onChange, disabled }: {
  rules: SsoRoleRule[]; onChange: (rules: SsoRoleRule[]) => void; disabled?: boolean;
}) {
  const { t } = useTranslation('settings');
  const baseId = useId();
  const full = rules.length >= MAX_ROLE_RULES;
  const update = (index: number, patch: Partial<SsoRoleRule>) =>
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  const roleOptions = [
    { value: 'admin' as const, label: t('sso.step3.roleAdmin') },
    { value: 'user' as const, label: t('sso.step3.roleMember') },
  ];

  return (
    <div className="space-y-2">
      {rules.length > 0 && (
        <div className="hidden grid-cols-[minmax(0,1fr)_auto_auto] gap-2 text-[13px] font-medium text-muted-foreground sm:grid">
          <span>{t('sso.step3.colValue')}</span>
          <span>{t('sso.step3.colRole')}</span>
          <span className="w-11" aria-hidden="true" />
        </div>
      )}
      <ul className="space-y-2">
        {rules.map((rule, index) => {
          const inputId = `${baseId}-${index}`;
          return (
            <li key={index} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <label htmlFor={inputId} className="sr-only">{t('sso.step3.colValue')} {index + 1}</label>
              <input id={inputId} dir="ltr" style={{ unicodeBidi: 'isolate' }} className={TECH_INPUT_CLASS}
                value={rule.value} disabled={disabled} maxLength={128}
                onChange={(event) => update(index, { value: event.target.value })} />
              <SegmentedControl<SsoLocalRole> label={`${t('sso.step3.colRole')} ${index + 1}`} options={roleOptions}
                value={rule.role} onChange={(role) => update(index, { role })} />
              <Button type="button" variant="ghost" size="icon"  disabled={disabled}
                aria-label={t('sso.step3.removeRule', { n: index + 1 })}
                onClick={() => onChange(rules.filter((_, i) => i !== index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm"  disabled={disabled || full}
          onClick={() => onChange([...rules, { value: '', role: 'user' }])}>
          <Plus aria-hidden="true" />{t('sso.step3.addRule')}
        </Button>
        {full && <span className="text-[13px] text-muted-foreground">{t('sso.step3.maxRules')}</span>}
      </div>
      <p className="text-[13px] text-muted-foreground">{t('sso.step3.ownerNote')}</p>
    </div>
  );
}
