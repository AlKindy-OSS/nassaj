import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { BookOpen, FileCode2 } from 'lucide-react';

import { Pill, PillBar } from '../../../shared/view/ui';

import MermaidDiagram from './MermaidDiagram';

type ArchitectureViewProps = {
  technical: string | null;
  simplified: string | null;
};

type DocVariant = 'technical' | 'simplified';

type CodeProps = {
  className?: string;
  children?: React.ReactNode;
};

/** Intercepts ```mermaid fences and renders them as real diagrams. */
function MarkdownCode({ className, children, ...props }: CodeProps) {
  const language = /language-(\w+)/.exec(className || '')?.[1];
  const raw = Array.isArray(children) ? children.join('') : String(children ?? '');

  if (language === 'mermaid') {
    return <MermaidDiagram code={raw.trim()} />;
  }

  return (
    <code className={className} {...props}>
      {children}
    </code>
  );
}

export default function ArchitectureView({ technical, simplified }: ArchitectureViewProps) {
  const { t } = useTranslation('projectBoard');
  const [variant, setVariant] = useState<DocVariant>(() => (technical ? 'technical' : 'simplified'));

  // Clamp the selection to a variant that actually exists on disk.
  const activeVariant: DocVariant =
    variant === 'technical'
      ? (technical ? 'technical' : 'simplified')
      : (simplified ? 'simplified' : 'technical');
  const content = activeVariant === 'technical' ? technical : simplified;
  // ARCHITECTURE_AR.md is Arabic prose; render it right-to-left regardless of UI language.
  const contentDir = activeVariant === 'simplified' ? 'rtl' : 'auto';

  if (!technical && !simplified) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">
        {t('architecture.missing')}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4 py-2">
        <PillBar>
          <Pill
            isActive={activeVariant === 'technical'}
            onClick={() => setVariant('technical')}
            className="px-2.5 py-[5px]"
          >
            <FileCode2 className="h-3.5 w-3.5" />
            <span>{t('architecture.technical')}</span>
          </Pill>
          <Pill
            isActive={activeVariant === 'simplified'}
            onClick={() => setVariant('simplified')}
            className="px-2.5 py-[5px]"
          >
            <BookOpen className="h-3.5 w-3.5" />
            <span>{t('architecture.simplified')}</span>
          </Pill>
        </PillBar>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        {content ? (
          <div
            dir={contentDir}
            className="prose prose-sm max-w-3xl text-foreground dark:prose-invert prose-headings:text-foreground prose-code:before:content-none prose-code:after:content-none"
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: MarkdownCode }}>
              {content}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="p-8 text-center text-sm text-muted-foreground">
            {t('architecture.variantMissing')}
          </div>
        )}
      </div>
    </div>
  );
}
