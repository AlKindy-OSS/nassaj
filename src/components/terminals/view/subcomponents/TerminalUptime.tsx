import { useTranslation } from 'react-i18next';

import { formatUptime, terminalUptimeMs, type UptimeSource } from '../../utils/uptime';

type TerminalUptimeProps = {
  terminal: UptimeSource;
  /** Shared tick from the parent (see useNowTick) — one timer per list. */
  now: number;
  className?: string;
};

/**
 * Runtime badge: live for a running terminal, frozen at the exit instant for an
 * exited one. `dir="ltr"` + tabular figures keep `01:02:03` stable under RTL
 * and stop the row from twitching as digits change width.
 */
export default function TerminalUptime({ terminal, now, className }: TerminalUptimeProps) {
  const { t } = useTranslation('terminals');
  const elapsed = terminalUptimeMs(terminal, now);

  if (elapsed === null) {
    return null;
  }

  const label = terminal.status === 'exited' ? t('uptime.ranFor') : t('uptime.label');

  return (
    <span
      dir="ltr"
      title={label}
      aria-label={`${label}: ${formatUptime(elapsed)}`}
      className={`inline-block font-mono tabular-nums ${className ?? ''}`}
    >
      {formatUptime(elapsed)}
    </span>
  );
}
