import type { AttachmentBlob, LiveClient, Outcome } from './liveClient';

export const ATTACHMENT_CONCURRENCY = 2;
const MAX_RETRIES = 2;
const RASTER = /^image\/(png|jpeg|gif|webp)$/i;

export type AttachmentResult =
  | { status: 'ok'; url: string; type: string }
  | { status: 'gone' | 'too-large' | 'failed' };

type Waiter = () => void;

/**
 * Fetches attachments as blobs (at most two at a time, honouring Retry-After) and
 * hands out blob: URLs. Every URL is revoked on `dispose`. SVG and any non-raster
 * image type is refused, never rendered.
 */
export class AttachmentStore {
  private readonly cache = new Map<string, Promise<AttachmentResult>>();
  private readonly urls = new Set<string>();
  private readonly queue: Waiter[] = [];
  private active = 0;
  private disposed = false;

  constructor(
    private readonly client: LiveClient,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
  ) {}

  load(ref: string, kind: 'image' | 'file'): Promise<AttachmentResult> {
    const key = `${kind}:${ref}`;
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.run(ref, kind);
      this.cache.set(key, pending);
      // A failure is final for this view; a gone/too-large marker should not be re-fetched either.
    }
    return pending;
  }

  dispose(): void {
    this.disposed = true;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls.clear();
    this.cache.clear();
  }

  private async slot(): Promise<void> {
    if (this.active < ATTACHMENT_CONCURRENCY) { this.active += 1; return; }
    await new Promise<void>((resolve) => { this.queue.push(resolve); });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next(); else this.active -= 1;
  }

  private async fetchWithRetry(ref: string): Promise<Outcome<AttachmentBlob>> {
    let result = await this.client.attachment(ref);
    for (let attempt = 0; attempt < MAX_RETRIES && !this.disposed; attempt += 1) {
      if (result.ok || (result.failure.kind !== 'rate-limited' && result.failure.kind !== 'temporary')) break;
      await this.sleep(result.failure.retryAfterMs);
      result = await this.client.attachment(ref);
    }
    return result;
  }

  private async run(ref: string, kind: 'image' | 'file'): Promise<AttachmentResult> {
    await this.slot();
    try {
      const result = await this.fetchWithRetry(ref);
      if (this.disposed) return { status: 'failed' };
      if (!result.ok) {
        const { failure } = result;
        if (failure.kind === 'attachment-gone' || failure.kind === 'ended') return { status: 'gone' };
        return { status: failure.kind === 'attachment-too-large' ? 'too-large' : 'failed' };
      }
      const type = result.value.type.split(';')[0].trim();
      if (kind === 'image' && !RASTER.test(type)) return { status: 'failed' };
      const blob = kind === 'image' ? result.value.blob : new Blob([result.value.blob], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      this.urls.add(url);
      return { status: 'ok', url, type };
    } finally {
      this.release();
    }
  }
}
