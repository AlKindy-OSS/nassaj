import { ChevronDown, Send } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { AgyTextToolCall } from '../../utils/agyTextToolCall';

import { Markdown } from './Markdown';

/**
 * B-1665: an Antigravity `send_message(...)` call that arrived as reply text,
 * shown as a compact collapsible card instead of raw call syntax. The original
 * message text is untouched, so copy and search still see it verbatim.
 */
export default function AgyTextToolCalls({ calls }: { calls: AgyTextToolCall[] }) {
  const { t } = useTranslation('chat');
  if (calls.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {calls.map((call, index) => (
        <details
          key={`${call.recipient}-${index}`}
          className="group/agy rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm"
        >
          <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Send className="h-3.5 w-3.5 flex-shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            <span>{t('agyMessage.to', { name: call.recipientName || call.recipient })}</span>
            <ChevronDown
              className="ms-auto h-3 w-3 flex-shrink-0 transition-transform group-open/agy:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <Markdown className="prose prose-sm mt-1.5 max-w-none dark:prose-invert">{call.message}</Markdown>
        </details>
      ))}
    </div>
  );
}
