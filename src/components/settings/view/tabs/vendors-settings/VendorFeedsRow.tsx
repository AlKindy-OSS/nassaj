import { useTranslation } from 'react-i18next';

import { Button, Tooltip } from '../../../../../shared/view/ui';
import StatusBadge from '../../StatusBadge';

import {
  FEED_STATES_WITH_ACTION,
  FEED_TONE,
  type FeedItem,
} from './vendorFeeds';

type VendorFeedsRowProps = {
  items: readonly FeedItem[];
  /** The vendor feeds the Claude engine pin (an AES-only slot): one more badge, always. */
  enginePin: boolean;
  /** Opens the replace confirm; `null` hides the action (nothing foreign to replace). */
  onReplace: (() => void) | null;
  /** The key field is filled, so a replacement has a value to write. */
  canReplace: boolean;
  /** Opens the harness account page, for the states fixed by the link mode. */
  onOpenAccount: ((provider: string) => void) | null;
};

const ACCOUNT_STATES = new Set(['kept_on_subscription', 'mode_unset']);

/** One badge: `Harness · state`, with the action line in a tooltip when something needs doing. */
function FeedBadge({ item }: { item: FeedItem }) {
  const { t } = useTranslation('settings');
  const label = (
    <StatusBadge tone={FEED_TONE[item.state]}>
      <span><bdi>{item.harness}</bdi>{' · '}{t(`vendors.link.state.${item.state}`)}</span>
    </StatusBadge>
  );
  if (!FEED_STATES_WITH_ACTION.includes(item.state)) return label;
  return (
    <Tooltip
      content={t(`vendors.link.action.${item.state}`)}
      position="bottom"
      multiline
      tapToToggle
      keyboard
    >
      {label}
    </Tooltip>
  );
}

/**
 * The «يغذّي:» row (ADR-200 S9, brief §1): one quiet badge per harness the
 * vendor's single key feeds, so the user learns about a billing change here and
 * not from the invoice. The warning lives only where something is wrong.
 */
export default function VendorFeedsRow({
  items,
  enginePin,
  onReplace,
  canReplace,
  onOpenAccount,
}: VendorFeedsRowProps) {
  const { t } = useTranslation('settings');
  if (items.length === 0 && !enginePin) return null;

  const accountItem = onOpenAccount
    ? items.find((item) => ACCOUNT_STATES.has(item.state) && (item.provider === 'claude' || item.provider === 'codex'))
    : undefined;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="vendor-feeds">
      <span className="text-[13px] text-muted-foreground">{t('vendors.link.feeds')}</span>
      {items.map((item) => <FeedBadge key={item.vendorId} item={item} />)}
      {enginePin && (
        <Tooltip content={t('vendors.link.enginePin.tooltip')} position="bottom" multiline tapToToggle keyboard>
          <StatusBadge tone="info">{t('vendors.link.enginePin.badge')}</StatusBadge>
        </Tooltip>
      )}
      {onReplace && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onReplace}
          disabled={!canReplace}
          title={canReplace ? undefined : t('vendors.link.replacePasteFirst')}
        >
          {t('vendors.link.replace')}
        </Button>
      )}
      {accountItem && onOpenAccount && (
        <button
          type="button"
          onClick={() => onOpenAccount(accountItem.provider)}
          className="min-h-6 rounded-sm text-[13px] text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('vendors.link.openAccount')}
        </button>
      )}
    </div>
  );
}
