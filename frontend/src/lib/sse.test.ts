/**
 * Unit: connectAuditStream (the injectable SSE client) — sse.ts.
 *
 * Input classes (how the client behaves against an injected EventSource):
 *  C1  named-listener registration — one listener per AUDIT_EVENT_TYPES; onmessage
 *                                    is never used (the engine emits NAMED events).
 *  C2  delivered event             — a well-formed frame is parsed → onEvent, and
 *                                    onConnected fires (a delivered event = healthy).
 *  C3  malformed frame             — a bad-JSON frame is skipped, never onEvent, never throws.
 *  C4  reconnect on error          — onerror → onReconnecting(attempt) + a reopen
 *                                    scheduled through the injected backoff.
 *  C5  attempt reset               — a delivered event resets the attempt counter so a
 *                                    later error reconnects from attempt 1 again.
 *  C6  retries exhausted           — beyond maxRetries → onFailed, no further reopen.
 *  C7  isDone stops reconnect      — a terminal isDone()===true short-circuits reconnect.
 *  C8  close idempotence           — close() twice is safe; a closed stream ignores events/errors.
 *
 * Blackbox: a fake EventSourceCtor records listeners and lets the test drive
 * emit()/fail(); a synchronous backoff + fake timers remove all real waiting.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  connectAuditStream,
  connectScanStream,
  type EventSourceCtor,
  type EventSourceLike,
} from "./sse.ts";
import { AUDIT_EVENT_TYPES } from "./engine-types.ts";

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  readonly listeners = new Map<string, (ev: MessageEvent) => void>();
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  /** simulate the engine delivering a named frame */
  emit(type: string, data: string): void {
    this.listeners.get(type)?.({ data } as MessageEvent);
  }
  /** simulate a transport drop */
  fail(): void {
    this.onerror?.({} as Event);
  }
  static latest(): FakeEventSource {
    const s = FakeEventSource.instances.at(-1);
    if (!s) throw new Error("no EventSource constructed");
    return s;
  }
}

const Ctor = FakeEventSource as unknown as EventSourceCtor;
const frame = (payload: object) => JSON.stringify(payload);

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("connectAuditStream — C1 named-listener registration", () => {
  it("C1: registers exactly one listener per AUDIT_EVENT_TYPES and never uses onmessage", () => {
    const handle = connectAuditStream("/api/audit/a/events", { onEvent: () => {} }, { eventSource: Ctor });
    const src = FakeEventSource.latest();
    expect([...src.listeners.keys()].sort()).toEqual([...AUDIT_EVENT_TYPES].sort());
    expect(src.onmessage).toBeNull();
    handle.close();
  });
});

describe("connectAuditStream — C2 delivered event", () => {
  it("C2: a well-formed frame is parsed to onEvent and marks the stream connected", () => {
    const onEvent = vi.fn();
    const onConnected = vi.fn();
    const handle = connectAuditStream("/api/audit/a/events", { onEvent, onConnected }, { eventSource: Ctor });
    FakeEventSource.latest().emit("audit_started", frame({ type: "audit_started", seq: 1, packageName: "chalk" }));
    expect(onEvent).toHaveBeenCalledWith({ type: "audit_started", seq: 1, packageName: "chalk" });
    expect(onConnected).toHaveBeenCalled();
    handle.close();
  });
});

describe("connectAuditStream — C3 malformed frame", () => {
  it("C3: a bad-JSON frame is skipped — no onEvent, no throw", () => {
    const onEvent = vi.fn();
    const handle = connectAuditStream("/api/audit/a/events", { onEvent }, { eventSource: Ctor });
    expect(() => FakeEventSource.latest().emit("audit_started", "{not valid json")).not.toThrow();
    expect(onEvent).not.toHaveBeenCalled();
    handle.close();
  });
});

describe("connectAuditStream — C4 reconnect on error", () => {
  it("C4: onerror schedules a reopen through the injected backoff and reports the attempt", () => {
    const onReconnecting = vi.fn();
    const backoffMs = vi.fn(() => 1000);
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent: () => {}, onReconnecting },
      { eventSource: Ctor, backoffMs },
    );
    expect(FakeEventSource.instances).toHaveLength(1);
    FakeEventSource.latest().fail();
    expect(onReconnecting).toHaveBeenCalledWith(1);
    expect(backoffMs).toHaveBeenCalledWith(1);
    expect(FakeEventSource.instances).toHaveLength(1); // not yet — waiting on the timer
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.instances).toHaveLength(2); // reopened
    handle.close();
  });
});

describe("connectAuditStream — C5 attempt reset", () => {
  it("C5: a delivered event resets attempts so the next error reconnects from 1 again", () => {
    const onReconnecting = vi.fn();
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent: () => {}, onReconnecting },
      { eventSource: Ctor, backoffMs: () => 0 },
    );
    FakeEventSource.latest().fail(); // attempt 1
    vi.advanceTimersByTime(0);
    FakeEventSource.latest().fail(); // attempt 2 (no delivered event yet)
    vi.advanceTimersByTime(0);
    expect(onReconnecting).toHaveBeenNthCalledWith(1, 1);
    expect(onReconnecting).toHaveBeenNthCalledWith(2, 2);

    // a healthy frame arrives → attempts reset
    FakeEventSource.latest().emit("audit_started", frame({ type: "audit_started", seq: 1, packageName: "x" }));
    FakeEventSource.latest().fail(); // should be attempt 1 again, not 3
    expect(onReconnecting).toHaveBeenNthCalledWith(3, 1);
    handle.close();
  });
});

describe("connectAuditStream — C6 retries exhausted", () => {
  it("C6: beyond maxRetries the client gives up with onFailed", () => {
    const onFailed = vi.fn();
    const onReconnecting = vi.fn();
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent: () => {}, onReconnecting, onFailed },
      { eventSource: Ctor, backoffMs: () => 0, maxRetries: 2 },
    );
    FakeEventSource.latest().fail(); // attempt 1
    vi.advanceTimersByTime(0);
    FakeEventSource.latest().fail(); // attempt 2
    vi.advanceTimersByTime(0);
    FakeEventSource.latest().fail(); // attempt 3 > maxRetries → onFailed
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onReconnecting).toHaveBeenCalledTimes(2); // only for attempts 1 and 2
    handle.close();
  });
});

describe("connectAuditStream — C7 isDone stops reconnect", () => {
  it("C7: a terminal isDone() short-circuits reconnect (no onReconnecting, no reopen)", () => {
    const onReconnecting = vi.fn();
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent: () => {}, onReconnecting },
      { eventSource: Ctor, backoffMs: () => 0, isDone: () => true },
    );
    FakeEventSource.latest().fail(); // engine closed after the terminal event
    vi.advanceTimersByTime(0);
    expect(onReconnecting).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1); // never reopened
    handle.close();
  });
});

describe("connectAuditStream — C8 close idempotence", () => {
  it("C8: close() twice is safe and a closed stream ignores later frames/errors", () => {
    const onEvent = vi.fn();
    const onReconnecting = vi.fn();
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent, onReconnecting },
      { eventSource: Ctor, backoffMs: () => 0 },
    );
    const src = FakeEventSource.latest();
    handle.close();
    expect(() => handle.close()).not.toThrow(); // idempotent
    expect(src.closed).toBe(true);

    src.emit("audit_started", frame({ type: "audit_started", seq: 1, packageName: "x" }));
    src.fail();
    vi.advanceTimersByTime(1000);
    expect(onEvent).not.toHaveBeenCalled(); // closed → dropped
    expect(onReconnecting).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

/**
 * Unit: connectScanStream (the panel repo-scan client) — sse.ts.
 *
 * The panel stream is the mirror image of the audit stream: UNNAMED default
 * messages (onmessage, never named listeners) and NO reconnect — on error it
 * closes and fires onError so the caller does a full reload; the terminal
 * {type:"done"} is delivered to onMessage (the caller reloads on it).
 *
 * Input classes:
 *  S1  unnamed-message parse — a well-formed default frame is JSON-parsed to
 *                              ScanStreamMessage and handed to onMessage; no named
 *                              listeners are registered.
 *  S2  malformed frame       — a bad-JSON default frame is skipped, never onMessage,
 *                              never throws.
 *  S3  error → onError       — onerror closes the source and fires onError exactly
 *                              once; NO reopen (no reconnect).
 *  S4  terminal done         — {type:"done"} is delivered verbatim to onMessage so
 *                              the caller can reload.
 *  S5  close idempotence     — close() twice is safe; a closed stream drops later
 *                              messages/errors.
 */

/** deliver an UNNAMED default frame the way native EventSource fires onmessage */
const deliver = (src: FakeEventSource, data: string) =>
  src.onmessage?.({ data } as MessageEvent);

describe("connectScanStream — S1 unnamed-message parse", () => {
  it("S1: a default frame is parsed to onMessage; no named listeners are used", () => {
    const onMessage = vi.fn();
    const handle = connectScanStream("/api/panel/scan/1/events", { onMessage }, { eventSource: Ctor });
    const src = FakeEventSource.latest();
    expect(src.listeners.size).toBe(0); // panel stream is unnamed-only
    deliver(
      src,
      frame({ type: "dep", name: "chalk", version: "5.0.0", verdict: "SAFE", verdictReason: null, evidenceCount: 0, jobState: null }),
    );
    expect(onMessage).toHaveBeenCalledWith({
      type: "dep",
      name: "chalk",
      version: "5.0.0",
      verdict: "SAFE",
      verdictReason: null,
      evidenceCount: 0,
      jobState: null,
    });
    handle.close();
  });
});

describe("connectScanStream — S2 malformed frame", () => {
  it("S2: a bad-JSON default frame is skipped — no onMessage, no throw", () => {
    const onMessage = vi.fn();
    const handle = connectScanStream("/api/panel/scan/1/events", { onMessage }, { eventSource: Ctor });
    expect(() => deliver(FakeEventSource.latest(), "{not json")).not.toThrow();
    expect(onMessage).not.toHaveBeenCalled();
    handle.close();
  });
});

describe("connectScanStream — S3 error → onError", () => {
  it("S3: onerror closes the source and fires onError once, with no reconnect", () => {
    const onError = vi.fn();
    const onMessage = vi.fn();
    const handle = connectScanStream(
      "/api/panel/scan/1/events",
      { onMessage, onError },
      { eventSource: Ctor },
    );
    const src = FakeEventSource.latest();
    src.fail();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(src.closed).toBe(true);
    expect(FakeEventSource.instances).toHaveLength(1); // NO reopen — the caller reloads
    // a second error after close is a no-op
    src.fail();
    expect(onError).toHaveBeenCalledTimes(1);
    handle.close();
  });
});

describe("connectScanStream — S4 terminal done", () => {
  it("S4: {type:'done'} is delivered verbatim to onMessage so the caller reloads", () => {
    const onMessage = vi.fn();
    const handle = connectScanStream("/api/panel/scan/1/events", { onMessage }, { eventSource: Ctor });
    deliver(FakeEventSource.latest(), frame({ type: "done" }));
    expect(onMessage).toHaveBeenCalledWith({ type: "done" });
    handle.close();
  });
});

describe("connectScanStream — S5 close idempotence", () => {
  it("S5: close() twice is safe and a closed stream drops later messages/errors", () => {
    const onMessage = vi.fn();
    const onError = vi.fn();
    const handle = connectScanStream(
      "/api/panel/scan/1/events",
      { onMessage, onError },
      { eventSource: Ctor },
    );
    const src = FakeEventSource.latest();
    handle.close();
    expect(() => handle.close()).not.toThrow();
    expect(src.closed).toBe(true);
    deliver(src, frame({ type: "done" }));
    src.fail();
    expect(onMessage).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
});
