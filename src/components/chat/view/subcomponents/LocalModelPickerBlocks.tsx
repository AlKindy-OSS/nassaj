/**
 * LocalModelPickerBlocks — one cmdk group per local model server under a coding
 * agent that runs on them (Claude, Codex) in the new-chat picker (ADR-227
 * Decision 10, T-2098 stage 3b, T-2107 stage 5).
 *
 * A row the member can fix in the server's settings opens those settings (the
 * same contract as a locked engine row); a row a pin rule forbids is disabled.
 */
import { Check, Server, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CommandGroup, CommandItem } from '../../../../shared/view/ui';

import type { LocalPickerBlock, LocalPickerRow } from './localOverlayRows';
import { localBlockHeading, localBlockText, localEngineLine } from './localModelText';

type Props = {
  blocks: LocalPickerBlock[];
  isSelected: (row: LocalPickerRow) => boolean;
  onSelect: (row: LocalPickerRow) => void;
  onOpenServerSettings: () => void;
};

type BlockProps = Omit<Props, 'blocks'> & { block: LocalPickerBlock };

/** One server's group: its heading and a row per model. */
function LocalPickerGroup({ block, isSelected, onSelect, onOpenServerSettings }: BlockProps) {
  const { t } = useTranslation('chat');
  const engineLine = localEngineLine(t, block.body);
  return (
    <CommandGroup
      data-testid="local-model-block"
      className="border-t border-border/40 [&_[cmdk-group-heading]]:mt-1"
      heading={(
        <span className="flex items-center gap-1.5">
          <Server className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{localBlockHeading(t, block.serverLabel)}</span>
        </span>
      )}
    >
      {block.rows.map((row) => {
        const reason = row.blocked ? localBlockText(t, { ...row, blocked: row.blocked }) : null;
        return (
          <CommandItem
            key={row.key}
            value={`${block.serverLabel} ${row.label} ${reason ?? engineLine}`}
            disabled={row.blocked !== null && !row.fixInSettings}
            data-local-blocked={row.blocked ?? undefined}
            onSelect={() => {
              if (!row.blocked) onSelect(row);
              else if (row.fixInSettings) onOpenServerSettings();
            }}
            className="ms-4 border-s border-border/40 ps-4"
          >
            <div className="min-w-0 flex-1">
              {/* Model ids are Latin text: isolated so a colon or slash does not reorder. */}
              <div className={row.blocked ? 'truncate text-muted-foreground' : 'truncate'}>
                <bdi>{row.label}</bdi>
              </div>
              <div className="truncate text-xs text-muted-foreground">{reason ?? engineLine}</div>
            </div>
            {row.blocked && row.fixInSettings && (
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-primary">
                <Settings className="h-3 w-3" aria-hidden="true" />
                {t('localModels.openSettings', { defaultValue: 'Server settings' })}
              </span>
            )}
            {!row.blocked && isSelected(row) && (
              <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            )}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

export default function LocalModelPickerBlocks({ blocks, ...rest }: Props) {
  return (
    <>
      {blocks.map((block) => <LocalPickerGroup key={`${block.body}:${block.providerId}`} block={block} {...rest} />)}
    </>
  );
}
