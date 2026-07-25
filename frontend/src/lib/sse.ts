/**
 * SSE clients for the two engine stream shapes:
 *
 * - Audit stream (/audit/:id/events): NAMED events — one listener per event
 *   type; `onmessage` never fires. Reconnect resumes from a seq cursor: native
 *   EventSource re-sends the last `id:` as Last-Event-ID and the engine replays
 *   only events after it (it also accepts ?since=<seq>). Either way the fold's
 *   seq guard makes replay idempotent, so the client never reasons about dupes.
 * - Audit-set progress stream (/panel/scan/:id/events): UNNAMED default messages
 *   via `onmessage` — per-name listeners receive nothing. Frames DO carry an
 *   `id:` line (the durable log's seq), so a native EventSource reconnect resumes
 *   from Last-Event-ID exactly as the audit stream does; every frame is a snapshot
 *   of its subject, so a replayed one is idempotent. On error it closes and fires
 *   `onError` so the caller does a full reload; the terminal {type:"done"}
 *   triggers one too. ONE stream for every origin: a public-repo audit and an
 *   owned-repo scan are the same entity and are followed by this same code.
 *
 * The EventSource constructor and backoff are injectable so unit tests drive a
 * fake with no real timers or network.
 */

import { ScanStreamFrameSchema, type ScanStreamFrame } from "@npmguard/shared";
import { AUDIT_EVENT_TYPES, type AuditEvent } from "./engine-types.ts";

/** Structural EventSource surface — deliberately wider than the DOM lib's
 * overloaded signatures so test fakes can satisfy it. */
export type EventSourceLike = {
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
  onerror: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
};

export type EventSourceCtor = new (url: string) => EventSourceLike;

export interface AuditStreamHandlers {
  onEvent: (event: AuditEvent) => void;
  /** attempt is 1-based; called before each reconnect wait */
  onReconnecting?: (attempt: number) => void;
  /** all reconnect attempts exhausted */
  onFailed?: () => void;
  onConnected?: () => void;
}

export interface AuditStreamOptions {
  eventSource?: EventSourceCtor;
  maxRetries?: number;
  /** attempt (1-based) → delay ms; injectable so tests skip real waits */
  backoffMs?: (attempt: number) => number;
  /** stop reconnecting once the stream is expected to be closed (terminal) */
  isDone?: () => boolean;
}

export interface StreamHandle {
  close: () => void;
}

const defaultBackoff = (attempt: number) => Math.min(1000 * 2 ** (attempt - 1), 16000);

export function connectAuditStream(
  url: string,
  handlers: AuditStreamHandlers,
  options: AuditStreamOptions = {},
): StreamHandle {
  const Ctor: EventSourceCtor = options.eventSource ?? (EventSource as unknown as EventSourceCtor);
  const maxRetries = options.maxRetries ?? 5;
  const backoff = options.backoffMs ?? defaultBackoff;

  let source: EventSourceLike | null = null;
  let closed = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    if (closed) return;
    source = new Ctor(url);
    for (const type of AUDIT_EVENT_TYPES) {
      source.addEventListener(type, (raw) => {
        if (closed) return;
        attempts = 0; // a delivered event proves the connection is healthy
        handlers.onConnected?.();
        let event: AuditEvent;
        try {
          event = JSON.parse((raw as MessageEvent).data) as AuditEvent;
        } catch {
          return; // malformed frame — skip, never throw into the stream
        }
        handlers.onEvent(event);
      });
    }
    source.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      if (options.isDone?.()) return; // stream ended normally (engine closes after the terminal event)
      attempts += 1;
      if (attempts > maxRetries) {
        handlers.onFailed?.();
        return;
      }
      handlers.onReconnecting?.(attempts);
      retryTimer = setTimeout(open, backoff(attempts));
    };
  };

  open();

  return {
    close() {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      source?.close();
      source = null;
    },
  };
}

export interface ScanStreamHandlers {
  onMessage: (frame: ScanStreamFrame) => void;
  onError?: () => void;
}

/** Audit-set progress stream. UNNAMED default messages (JSON → ScanStreamFrame).
 * No manual reconnect loop: EventSource's own retry already resumes from the
 * `id:` cursor, and on a hard error the caller degrades to a full reload (the
 * terminal {type:"done"} triggers one anyway). */
export function connectScanStream(
  url: string,
  handlers: ScanStreamHandlers,
  options: { eventSource?: EventSourceCtor } = {},
): StreamHandle {
  const Ctor: EventSourceCtor = options.eventSource ?? (EventSource as unknown as EventSourceCtor);
  const source = new Ctor(url);
  let closed = false;

  source.onmessage = (raw) => {
    if (closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.data);
    } catch {
      return; // malformed frame — skip, never throw into the stream
    }
    // A frame is a wire response like any other, so it is CHECKED, not cast.
    // These frames drive the dependency table directly: a `dep` frame whose
    // `item` has lost a field used to overwrite a good row with a half one, and
    // the cast made that invisible. A frame that does not match the contract is
    // treated as a transport failure — closed, then `onError`, whose callers all
    // recover by refetching the authoritative response. Degrading to the source
    // of truth is the honest recovery; silently dropping the frame would leave
    // the row frozen at a stale value with nothing said.
    const frame = ScanStreamFrameSchema.safeParse(parsed);
    if (!frame.success) {
      closed = true;
      source.close();
      handlers.onError?.();
      return;
    }
    handlers.onMessage(frame.data);
  };
  source.onerror = () => {
    if (closed) return;
    closed = true;
    source.close();
    handlers.onError?.();
  };

  return {
    close() {
      closed = true;
      source.close();
    },
  };
}
