import { useEffect, useRef, useState, type RefObject } from 'react';

import type { AttachmentResult, AttachmentStore } from './attachmentStore';
import type { ViewerStrings } from './i18n';
import type { LivePart } from './types';

function useInView<T extends Element>(): [RefObject<T>, boolean] {
  const target = useRef<T>(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const node = target.current;
    if (seen || !node) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setSeen(true); observer.disconnect(); }
    }, { rootMargin: '200px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [seen]);
  return [target, seen];
}

type ImagePart = Extract<LivePart, { t: 'image' }>;
type FilePart = Extract<LivePart, { t: 'file' }>;

function Marker({ text }: { text: string }) {
  return <span className="share-redacted" data-cat="attachment">{text}</span>;
}

/** Image attachment: fetched lazily when scrolled near, shown from a blob: URL. */
export function ImageAttachment({ part, store, strings }: { part: ImagePart; store: AttachmentStore; strings: ViewerStrings }) {
  const [target, inView] = useInView<HTMLSpanElement>();
  const [result, setResult] = useState<AttachmentResult | null>(null);
  useEffect(() => {
    if (!inView) return undefined;
    let current = true;
    void store.load(part.ref, 'image').then((value) => { if (current) setResult(value); });
    return () => { current = false; };
  }, [inView, store, part.ref]);

  if (result?.status === 'ok') {
    return <img className="share-attachment-image" src={result.url} alt={strings.attachment.imageAlt} />;
  }
  if (result) return <Marker text={result.status === 'too-large' ? strings.attachment.tooLarge : strings.attachment.gone} />;
  return <span ref={target} className="share-attachment-pending" role="img" aria-label={strings.loading} />;
}

/** File attachment: fetched on demand (click), saved through a blob: URL. */
export function FileAttachment({ part, store, strings }: { part: FilePart; store: AttachmentStore; strings: ViewerStrings }) {
  const [state, setState] = useState<'idle' | 'busy' | 'gone' | 'too-large'>('idle');
  const save = async () => {
    setState('busy');
    const result = await store.load(part.ref, 'file');
    if (result.status !== 'ok') { setState(result.status === 'too-large' ? 'too-large' : 'gone'); return; }
    const anchor = document.createElement('a');
    anchor.href = result.url;
    anchor.download = part.name;
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setState('idle');
  };
  if (state === 'gone' || state === 'too-large') {
    return <Marker text={state === 'too-large' ? strings.attachment.tooLarge : strings.attachment.gone} />;
  }
  return (
    <button type="button" className="share-attachment-file" onClick={() => { void save(); }} disabled={state === 'busy'}>
      <span aria-hidden="true">⬇</span>
      <bdi dir="ltr">{part.name}</bdi>
      <span className="share-sr-only">{strings.attachment.download}</span>
    </button>
  );
}
