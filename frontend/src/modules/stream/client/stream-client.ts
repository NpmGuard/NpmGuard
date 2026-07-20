import type { z } from "zod";

/**
 * SSE client over the durable log: validates each envelope against the
 * module's event union (build it with spine's defineEvents), dedupes by
 * seq, and reconnects with exponential backoff + jitter, resuming from the
 * cursor via `?since=`. Framework-free; a React hook belongs in the app
 * (or the shell module), not here.
 */

export type StreamStatus = "connecting" | "open" | "retrying" | "closed";

export interface EventSourceLike {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface StreamOptions<E extends { seq: number }> {
  url: string;
  schema: z.ZodType<E>;
  onEvent: (event: E) => void;
  /** Last seq already seen; replay starts after it. Default: from the beginning. */
  since?: number;
  onStatus?: (status: StreamStatus) => void;
  /** Called on an envelope that fails the schema. Default: throw — unknown
   * events are a contract violation, never silently ignored. */
  onParseError?: (error: Error, raw: string) => void;
  /** `random` is the jitter source — injectable because behavior that
   * depends on randomness is otherwise untestable (TESTING.md). */
  backoff?: { baseMs?: number; maxMs?: number; random?: () => number };
  /** Injectable for tests. Default: native EventSource. */
  createEventSource?: (url: string) => EventSourceLike;
}

export interface StreamHandle {
  close(): void;
  /** Highest seq seen so far (or the initial `since`). */
  cursor(): number;
}

export function connectStream<E extends { seq: number }>(
  options: StreamOptions<E>,
): StreamHandle {
  const baseMs = options.backoff?.baseMs ?? 500;
  const maxMs = options.backoff?.maxMs ?? 15_000;
  const random = options.backoff?.random ?? Math.random;
  const create =
    options.createEventSource ??
    ((url: string) => new EventSource(url) as unknown as EventSourceLike);

  let cursor = options.since ?? -1;
  let attempts = 0;
  let closed = false;
  let source: EventSourceLike | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const setStatus = (status: StreamStatus) => options.onStatus?.(status);

  const urlWithCursor = () => {
    const url = new URL(options.url, "http://resolve.invalid");
    url.searchParams.set("since", String(cursor));
    return options.url.startsWith("http")
      ? url.toString()
      : url.pathname + url.search;
  };

  const open = () => {
    if (closed) return;
    setStatus("connecting");
    source = create(urlWithCursor());
    source.onopen = () => {
      attempts = 0;
      setStatus("open");
    };
    source.onmessage = (message) => {
      const envelope = options.schema.safeParse(JSON.parse(message.data));
      if (!envelope.success) {
        const error = new Error(`stream event failed contract: ${envelope.error.message}`);
        if (options.onParseError) return options.onParseError(error, message.data);
        throw error;
      }
      if (envelope.data.seq <= cursor) return; // replayed duplicate
      cursor = envelope.data.seq;
      options.onEvent(envelope.data);
    };
    source.onerror = () => {
      if (closed) return;
      source?.close();
      source = null;
      setStatus("retrying");
      const delay = Math.min(maxMs, baseMs * 2 ** attempts) * (0.5 + random() * 0.5);
      attempts += 1;
      retryTimer = setTimeout(open, delay);
    };
  };

  open();

  return {
    close() {
      closed = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
      source?.close();
      setStatus("closed");
    },
    cursor: () => cursor,
  };
}
