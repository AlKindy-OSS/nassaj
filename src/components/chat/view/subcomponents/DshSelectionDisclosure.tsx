import { useId } from 'react';
import { Info } from 'lucide-react';
import { Trans, useTranslation } from 'react-i18next';

/** Latin names and ids inside the sentence stay isolated from the Arabic run. */
const ISOLATE = { b: <bdi /> };

/**
 * T-2086/ADR-224 — what a member should know before using DeepSeek Harness,
 * shown under the "ready" line once it is the chosen body. Neutral tone, the
 * same card shape as the other provider notices, no action required: the
 * facts are the preview (rc) build, DeepSeek's own SAFETY.md stating there was
 * no security audit, where the content goes, the fixed anonymous installation
 * identifier on every request, and that tools run under the server's shared
 * system account. With a local model chosen (T-2108) the content goes to the
 * member's own local model server instead, and that is what it says.
 */
const BODY_DEFAULT = {
  cloud: "<b>DeepSeek</b>'s <b>SAFETY.md</b> says it has not had a security audit. Your conversation and "
    + 'project content are sent to <b>DeepSeek</b>, and each request carries a fixed anonymous '
    + 'installation identifier. Its tools run on the server under the same system account as the '
    + 'other agents, so it can read files by absolute path.',
  local: "<b>DeepSeek</b>'s <b>SAFETY.md</b> says it has not had a security audit. With a local model, "
    + 'your conversation and project content go to your own local model server, not to <b>DeepSeek</b>. '
    + 'Its tools run on the server under the same system account as the other agents, so it can read '
    + 'files by absolute path.',
};

export default function DshSelectionDisclosure({ local = false }: { local?: boolean }) {
  const { t } = useTranslation('chat');
  const titleId = useId();

  return (
    <div
      role="note"
      aria-labelledby={titleId}
      className="mx-auto mt-4 max-w-md rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-start text-xs leading-relaxed text-muted-foreground"
    >
      <p id={titleId} className="flex items-start gap-2 font-medium text-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <Trans
            t={t}
            i18nKey="providerSelection.dshDisclosure.title"
            components={ISOLATE}
            defaults="<b>DeepSeek Harness</b> is a developer preview (<b>rc</b>)"
          />
        </span>
      </p>
      <p className="mt-1 ps-5">
        <Trans
          t={t}
          i18nKey={local ? 'providerSelection.dshDisclosure.body_local' : 'providerSelection.dshDisclosure.body'}
          components={ISOLATE}
          defaults={local ? BODY_DEFAULT.local : BODY_DEFAULT.cloud}
        />
      </p>
    </div>
  );
}
