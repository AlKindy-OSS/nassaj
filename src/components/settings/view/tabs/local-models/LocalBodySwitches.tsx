/**
 * LocalBodySwitches — per coding agent switches of the local models card (ADR-227,
 * T-2107 stage 5, T-2108). Each agent stays off until a manager turns it on, and only once
 * the feature itself is enabled (its consent recorded). Turning one on repeats the
 * existing disclosure and consent as a confirmation; turning one off asks nothing.
 */
import { useTranslation } from 'react-i18next';

import { confirmDialog } from '../../../../../shared/dialogs/dialogService';
import { LOCAL_BODIES, type LocalBody, type useLocalModels } from '../../../hooks/useLocalModels';
import SettingsRow from '../../SettingsRow';
import SettingsToggle from '../../SettingsToggle';

type Controller = ReturnType<typeof useLocalModels>;

/** Product names of the agents; not translated. */
const BODY_LABEL: Record<LocalBody, string> = { claude: 'Claude Code', codex: 'Codex', dsh: 'DeepSeek Harness' };

export default function LocalBodySwitches({ control }: { control: Controller }) {
  const { t } = useTranslation('settings');
  const feature = control.overview?.feature;
  if (!feature) return null;

  const toggle = async (body: LocalBody, enabled: boolean) => {
    if (enabled) {
      const accepted = await confirmDialog({
        title: t('localModels.bodyConfirmTitle', { agent: BODY_LABEL[body] }),
        message: `${t('localModels.disclosure')}\n\n${t('localModels.consent')}`,
        confirmLabel: t('localModels.bodyConfirm'),
      });
      if (!accepted) return;
    }
    await control.setBodyEnabled(body, enabled);
  };

  return <div className="space-y-2" data-testid="local-body-switches">
    <h3 className="text-[15px] font-medium text-foreground">{t('localModels.bodies')}</h3>
    <p className="text-[13px] text-muted-foreground">
      {t(feature.enabled ? 'localModels.bodiesDescription' : 'localModels.bodiesNeedActivation')}
    </p>
    {LOCAL_BODIES.map((body) => {
      const label = t('localModels.bodyOn', { agent: BODY_LABEL[body] });
      // A server that does not report an agent yet reads as off.
      const on = feature.bodies?.[body] === true;
      return <SettingsRow key={body} label={label}>
        {feature.canManage
          ? <SettingsToggle checked={on} ariaLabel={label}
            disabled={control.busy || (!on && !feature.enabled)}
            onChange={(value) => { void toggle(body, value); }} />
          : <span className="text-sm">{t(on ? 'localModels.bodyIsOn' : 'localModels.bodyIsOff')}</span>}
      </SettingsRow>;
    })}
  </div>;
}
