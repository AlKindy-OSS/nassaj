import React, { createContext, useContext, useMemo } from 'react';
import type { Components } from 'react-markdown';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  resolveBlockDirection,
  resolveContainerDirection,
  type TextDirection,
} from '../../../../../utils/textDirection';
import MarkdownCodeBlock from './MarkdownCodeBlock';

type MarkdownPreviewProps = {
  content: string;
};

/**
 * اتجاه الحاوية، يُمرَّر للكتل عبر السياق — نفس عقد
 * `src/components/chat/view/subcomponents/Markdown.tsx` حرفياً: الاتجاه يُحسم
 * لكل كتلة بالأغلبية، والحاوية بتصويت الكتل (كتلة = صوت). المعاينة هنا تعرض
 * ملفات `.md` من المستودع وأكثر توثيق المشروع عربي، فبلا هذا العقد كانت كل فقرة
 * تأخذ اتجاه المستند بلا حسم. المبرّر الكامل في `src/utils/textDirection.ts`.
 *
 * `null` ⇒ لا اتجاه محسوم، فالكتل ترث المستند ولا تحمل `dir` إطلاقاً.
 */
const ContainerDirContext = createContext<TextDirection | null>(null);

/** نصّ الكتلة من شجرة hast، مع استبعاد الشيفرة — لاتينية بحكم البناء لا اللغة. */
function hastText(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return String(node.value ?? '');
  if (node.type === 'element' && ['code', 'pre', 'kbd', 'samp'].includes(node.tagName)) {
    return ' ';
  }
  const children = node.children;
  return Array.isArray(children) ? children.map(hastText).join('') : '';
}

/** سِمة `dir` للكتلة — أو `undefined` فترث الحاوية. */
function useBlockDir(node: any): TextDirection | undefined {
  const containerDir = useContext(ContainerDirContext);
  return useMemo(() => resolveBlockDirection(hastText(node), containerDir), [node, containerDir]);
}

type BlockProps = { node?: any; children?: React.ReactNode };

/** مصنع مكوّنات الكتل: كلها تمرّ بنفس قاعدة الاتجاه، فلا يشذّ عنصر عن غيره. */
function blockComponent(tag: string, className?: string) {
  const Block = ({ node, children }: BlockProps) => {
    const dir = useBlockDir(node);
    return React.createElement(tag, { className, dir }, children);
  };
  Block.displayName = `MarkdownPreviewBlock_${tag}`;
  return Block;
}

const markdownPreviewComponents: Components = {
  code: MarkdownCodeBlock,
  h1: blockComponent('h1'),
  h2: blockComponent('h2'),
  h3: blockComponent('h3'),
  h4: blockComponent('h4'),
  li: blockComponent('li'),
  p: blockComponent('p', 'mb-2 last:mb-0'),
  blockquote: blockComponent(
    'blockquote',
    'my-2 border-s-4 border-gray-300 ps-4 italic text-gray-600 dark:border-gray-600 dark:text-gray-400',
  ),
  // محاذاة منطقية `text-start`: خلية العنوان كانت مُحاذاة يساراً فيزيائياً بينما
  // `td` ترث `start` ⇒ عمود مكسور المحاذاة في RTL.
  th: blockComponent(
    'th',
    'border border-gray-200 px-3 py-2 text-start text-sm font-semibold dark:border-gray-700',
  ),
  td: blockComponent(
    'td',
    'border border-gray-200 px-3 py-2 align-top text-sm dark:border-gray-700',
  ),
  a: ({ href, children }) => (
    <a href={href} className="text-blue-600 hover:underline dark:text-blue-400" target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="min-w-full border-collapse border border-gray-200 dark:border-gray-700">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-gray-50 dark:bg-gray-800">{children}</thead>,
};

export default function MarkdownPreview({ content }: MarkdownPreviewProps) {
  const remarkPlugins = useMemo(() => [remarkGfm, remarkMath], []);
  const rehypePlugins = useMemo(() => [rehypeKatex], []);

  const containerDir = useMemo(() => resolveContainerDirection(content), [content]);

  return (
    <div dir={containerDir ?? undefined}>
      <ContainerDirContext.Provider value={containerDir}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={markdownPreviewComponents}
        >
          {content}
        </ReactMarkdown>
      </ContainerDirContext.Provider>
    </div>
  );
}
