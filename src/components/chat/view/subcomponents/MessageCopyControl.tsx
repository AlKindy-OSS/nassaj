import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { copyTextToClipboard } from '../../../../utils/clipboard';

const COPY_SUCCESS_TIMEOUT_MS = 2000;

type CopyFormat = 'text' | 'markdown';

type CopyFormatOption = {
  format: CopyFormat;
  label: string;
};

// Converts markdown into readable plain text for "Copy as text".
const convertMarkdownToPlainText = (markdown: string): string => {
  let plainText = markdown.replace(/\r\n/g, '\n');
  const codeBlocks: string[] = [];
  plainText = plainText.replace(/```[\w-]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const placeholder = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(code.replace(/\n$/, ''));
    return placeholder;
  });
  plainText = plainText.replace(/`([^`]+)`/g, '$1');
  plainText = plainText.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  plainText = plainText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  plainText = plainText.replace(/^>\s?/gm, '');
  plainText = plainText.replace(/^#{1,6}\s+/gm, '');
  plainText = plainText.replace(/^[-*+]\s+/gm, '');
  plainText = plainText.replace(/^\d+\.\s+/gm, '');
  plainText = plainText.replace(/(\*\*|__)(.*?)\1/g, '$2');
  plainText = plainText.replace(/(\*|_)(.*?)\1/g, '$2');
  plainText = plainText.replace(/~~(.*?)~~/g, '$1');
  plainText = plainText.replace(/<\/?[^>]+(>|$)/g, '');
  plainText = plainText.replace(/\n{3,}/g, '\n\n');
  plainText = plainText.replace(/@@CODEBLOCK(\d+)@@/g, (_match, index: string) => codeBlocks[Number(index)] ?? '');
  return plainText.trim();
};

const MessageCopyControl = ({
  content,
  messageType,
  tone,
}: {
  content: string;
  messageType: 'user' | 'assistant';
  tone?: 'user-bubble';
}) => {
  const { t } = useTranslation('chat');
  const canSelectCopyFormat = messageType === 'assistant';
  const defaultFormat: CopyFormat = canSelectCopyFormat ? 'markdown' : 'text';
  const [selectedFormat, setSelectedFormat] = useState<CopyFormat>(defaultFormat);
  const [copied, setCopied] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copyFormatOptions: CopyFormatOption[] = useMemo(
    () => [
      {
        format: 'markdown',
        label: t('copyMessage.copyAsMarkdown', { defaultValue: 'Copy as markdown' }),
      },
      {
        format: 'text',
        label: t('copyMessage.copyAsText', { defaultValue: 'Copy as text' }),
      },
    ],
    [t]
  );

  const selectedFormatTag = selectedFormat === 'markdown'
    ? t('copyMessage.markdownShort', { defaultValue: 'MD' })
    : t('copyMessage.textShort', { defaultValue: 'TXT' });

  const copyPayload = useMemo(() => {
    if (selectedFormat === 'markdown') {
      return content;
    }
    return convertMarkdownToPlainText(content);
  }, [content, selectedFormat]);

  useEffect(() => {
    setSelectedFormat(defaultFormat);
    setIsDropdownOpen(false);
  }, [defaultFormat]);

  useEffect(() => {
    // Close the dropdown when clicking anywhere outside this control.
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!isDropdownOpen) return;
      const target = event.target as Node;
      if (dropdownRef.current && !dropdownRef.current.contains(target)) {
        setIsDropdownOpen(false);
      }
    };

    window.addEventListener('mousedown', closeOnOutsideClick);
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideClick);
    };
  }, [isDropdownOpen]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleCopyClick = async () => {
    if (!copyPayload.trim()) return;
    const didCopy = await copyTextToClipboard(copyPayload);
    if (!didCopy) return;

    setCopied(true);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopied(false);
    }, COPY_SUCCESS_TIMEOUT_MS);
  };

  const handleFormatChange = (format: CopyFormat) => {
    setSelectedFormat(format);
    setIsDropdownOpen(false);
  };

  const toneClass = tone === 'user-bubble'
    ? 'text-[hsl(var(--user-bubble-muted-foreground,var(--primary-foreground)))] hover:text-[hsl(var(--user-bubble-foreground,var(--primary-foreground)))]'
    : messageType === 'user'
      ? 'text-primary-foreground hover:text-primary-foreground'
      : 'text-muted-foreground hover:text-foreground';
  // The "MD"/"TXT" tag on this button names the COPY FORMAT, and nothing on the
  // surface said so — the tooltip read a bare "Copy" while the letters looked
  // like an author or a message type. Name the format the click will actually
  // use ("Copy as markdown"), so the tag explains itself on hover.
  const copyTitle = copied
    ? t('copyMessage.copied')
    : copyFormatOptions.find((option) => option.format === selectedFormat)?.label
      ?? t('copyMessage.copy');
  const rootClassName = 'relative flex min-w-max flex-none items-center gap-0.5';

  return (
    <div ref={dropdownRef} className={rootClassName}>
      <button
        type="button"
        onClick={handleCopyClick}
        title={copyTitle}
        aria-label={copyTitle}
        className={`inline-flex min-h-8 min-w-8 items-center justify-center gap-1 rounded px-2 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${toneClass}`}
      >
        {copied ? (
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
        <span className={`${messageType === 'assistant' ? 'sr-only sm:not-sr-only' : ''} text-[10px] font-semibold uppercase tracking-wide`}>{selectedFormatTag}</span>
      </button>

      {canSelectCopyFormat && (
        <>
          <button
            type="button"
            onClick={() => setIsDropdownOpen((prev) => !prev)}
            className={`inline-flex min-h-8 min-w-8 items-center justify-center rounded px-1 py-1 transition-colors ${toneClass}`}
            aria-label={t('copyMessage.selectFormat', { defaultValue: 'Select copy format' })}
            title={t('copyMessage.selectFormat', { defaultValue: 'Select copy format' })}
          >
            <svg
              className={`h-3 w-3 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {isDropdownOpen && (
            <div className="absolute left-auto top-full z-30 mt-1 min-w-36 rounded-md border border-border bg-card p-1 shadow-lg">
              {copyFormatOptions.map((option) => {
                const isSelected = option.format === selectedFormat;
                return (
                  <button
                    key={option.format}
                    type="button"
                    onClick={() => handleFormatChange(option.format)}
                    className={`block w-full rounded px-2 py-1.5 text-start transition-colors ${isSelected
                      ? 'bg-muted text-foreground'
                      : 'text-foreground hover:bg-accent'
                      }`}
                  >
                    <span className="block text-xs font-medium">{option.label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default MessageCopyControl;
