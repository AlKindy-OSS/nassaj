/**
 * WikiMermaidDiagram — the shared ZoomableMermaidDiagram with the wiki's
 * Arabic-only labels and CSS hooks.
 *
 * البند 3: على الجوال (<md):
 *  - الـSVG يُعرض بحجمه الطبيعي داخل حاوية overflow-x-auto (لا تقليص)،
 *    عبر data-wiki-mermaid الذي يرفع الخصوصية في wiki-panel.css
 *  - داخل الـoverlay: -webkit-overflow-scrolling: touch (wiki-mermaid-overlay)
 */

import { useMemo } from 'react';

import ZoomableMermaidDiagram from '../../../shared/view/ZoomableMermaidDiagram';
import { useWikiLabels } from '../useWikiLabels';

type WikiMermaidDiagramProps = {
  code: string;
};

const INLINE_WRAPPER_PROPS = { 'data-wiki-mermaid': 'true' };

export default function WikiMermaidDiagram({ code }: WikiMermaidDiagramProps) {
  const { t } = useWikiLabels();
  const labels = useMemo(
    () => ({ zoom: t('diagram.zoom'), zoomedAria: t('diagram.zoomedAria'), close: t('diagram.close') }),
    [t],
  );

  return (
    <ZoomableMermaidDiagram
      code={code}
      labels={labels}
      inlineWrapperProps={INLINE_WRAPPER_PROPS}
      overlayClassName="wiki-mermaid-overlay"
    />
  );
}
