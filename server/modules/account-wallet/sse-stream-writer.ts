import { stampWriterEpoch } from '@/shared/user-revocation-epoch.js';

import { DeviceBoundSseStream, type DeviceSseResponse } from './device-bound-sse-stream.js';

/** Production SSE transport with device-generation fencing on every emission. */
export class SSEStreamWriter {
  private sessionId: string | null = null;
  private readonly stream: DeviceBoundSseStream;
  readonly isSSEStreamWriter = true;

  constructor(
    res: DeviceSseResponse,
    readonly userId: string | number | null = null,
    authenticatedUser: unknown = null,
    private readonly accessFence: (() => 'identity_changed' | 'project_access_changed' | null) | null = null,
  ) {
    this.stream = new DeviceBoundSseStream(res, authenticatedUser);
    // B-1327: runs of this stream stay revocable before they register.
    stampWriterEpoch(this);
  }

  /** Ends a stale device stream and emits the normative revocation event. */
  revokeIdentity(): void {
    this.stream.invalidate();
  }

  /** Marks an HTTP disconnect and removes its operational registry entry. */
  markClientGone(): void {
    this.stream.markClientGone();
  }

  /** Sends only while the database still recognizes the stamped generation. */
  send(data: unknown): void {
    const stale = this.accessFence?.() ?? null;
    if (stale) {
      this.stream.invalidateAccess(stale);
      return;
    }
    this.stream.send(data);
  }

  /** Rechecks immediately after registration and before headers or first data. */
  assertCurrentAccess(): boolean {
    const stale = this.accessFence?.() ?? null;
    if (!stale) return true;
    this.stream.invalidateAccess(stale);
    return false;
  }

  /** Reads the frozen fence without committing headers; used for registration races. */
  staleAccessCode(): 'identity_changed' | 'project_access_changed' | null {
    return this.accessFence?.() ?? null;
  }

  /** Idempotently closes a stream whose immutable resource capture is stale. */
  revokeAccess(code: 'identity_changed' | 'project_access_changed'): void {
    this.stream.invalidateAccess(code);
  }

  /** Completes the stream and unregisters it from revocation fan-out. */
  end(): void {
    const stale = this.accessFence?.() ?? null;
    if (stale) {
      this.stream.invalidateAccess(stale);
      return;
    }
    this.stream.send({ type: 'done' });
    this.stream.end();
  }

  /** Associates subsequent provider output with a persisted session. */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
    this.send({ type: 'session-id', sessionId });
  }

  /** Returns the provider session id observed by the writer. */
  getSessionId(): string | null {
    return this.sessionId;
  }
}
