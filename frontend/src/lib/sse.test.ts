/**
 * Unit: connectAuditStream (the injectable SSE client) — sse.ts.
 *
 * Input classes (how the client behaves against an injected EventSource):
 *  C1  named-listener registration — one listener per AUDIT_EVENT_TYPES; onmessage
 *                                    is never used (the engine emits NAMED events).
 *  C2  delivered event             — a well-formed frame is parsed → onEvent, and
 *                                    onConnected fires (a delivered event = healthy).
 *  C3  malformed frame             — a bad-JSON frame is skipped, never onEvent, never throws.
 *  C9  contract violation          — a frame that PARSES as JSON but violates
 *                                    AuditEventSchema never reaches onEvent: the
 *                                    stream closes and onContractViolation fires,
 *                                    with NO reconnect (drift is deterministic, so
 *                                    retrying replays the same bad frame forever).
 *                                    The class an `as AuditEvent` cast makes
 *                                    silent.
 *  C4  reconnect on error          — onerror → onReconnecting(attempt) + a reopen
 *                                    scheduled through the injected backoff.
 *  C5  attempt reset               — a delivered event resets the attempt counter so a
 *                                    later error reconnects from attempt 1 again.
 *  C6  retries exhausted           — beyond maxRetries → onFailed, no further reopen.
 *  C7  isDone stops reconnect      — a terminal isDone()===true short-circuits reconnect.
 *  C8  close idempotence           — close() twice is safe; a closed stream ignores events/errors.
 *  C10 reconnect carries the cursor — a manual reopen is a NEW EventSource, which
 *                                    has no Last-Event-ID, so the highest delivered
 *                                    seq rides on `?since=`. Without it every drop
 *                                    replays the whole audit log from seq 0.
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
import { EVENT_TYPES } from "@npmguard/shared";

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

/** A CONTRACT-COMPLETE audit frame. The envelope fields are not decoration: the
 * client now parses every frame against `AuditEventSchema`, so a frame missing
 * `auditId`/`timestamp`/`seq` is a violation, exactly as it would be on the wire
 * (events.py flattens all four envelope fields onto every payload). */
const auditFrame = (payload: object, seq = 1) =>
  frame({ auditId: "aud-1", timestamp: "2026-07-25T00:00:00.000Z", seq, ...payload });

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
    expect([...src.listeners.keys()].sort()).toEqual([...EVENT_TYPES].sort());
    expect(src.onmessage).toBeNull();
    handle.close();
  });
});

describe("connectAuditStream — C2 delivered event", () => {
  it("C2: a well-formed frame is parsed to onEvent and marks the stream connected", () => {
    const onEvent = vi.fn();
    const onConnected = vi.fn();
    const handle = connectAuditStream("/api/audit/a/events", { onEvent, onConnected }, { eventSource: Ctor });
    FakeEventSource.latest().emit("audit_started", auditFrame({ type: "audit_started", packageName: "chalk" }));
    expect(onEvent).toHaveBeenCalledWith({
      type: "audit_started",
      auditId: "aud-1",
      timestamp: "2026-07-25T00:00:00.000Z",
      seq: 1,
      packageName: "chalk",
    });
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
    FakeEventSource.latest().emit("audit_started", auditFrame({ type: "audit_started", packageName: "x" }));
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

    src.emit("audit_started", auditFrame({ type: "audit_started", packageName: "x" }));
    src.fail();
    vi.advanceTimersByTime(1000);
    expect(onEvent).not.toHaveBeenCalled(); // closed → dropped
    expect(onReconnecting).not.toHaveBeenCalled();
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});

describe("connectAuditStream — C9 contract violation", () => {
  /** A frame that is valid JSON and a real event NAME, but has lost a field —
   * the shape a cast lets flow straight into the fold. `file_list` without
   * `files` is not a cosmetic gap: the fold iterates it. */
  it("C9: a frame violating its schema never reaches onEvent; the stream closes and reports drift", () => {
    const onEvent = vi.fn();
    const onContractViolation = vi.fn();
    const onReconnecting = vi.fn();
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent, onContractViolation, onReconnecting },
      { eventSource: Ctor, backoffMs: () => 0 },
    );
    const src = FakeEventSource.latest();
    src.emit("file_list", auditFrame({ type: "file_list" })); // `files` dropped

    expect(onEvent).not.toHaveBeenCalled();
    expect(src.closed).toBe(true);
    expect(onContractViolation).toHaveBeenCalledTimes(1);
    // the detail names the event and the offending path, for a support conversation
    expect(onContractViolation.mock.calls[0]?.[0]).toContain("file_list");
    expect(onContractViolation.mock.calls[0]?.[0]).toContain("files");

    // NO reconnect: the same engine would send the same bad frame.
    vi.advanceTimersByTime(60_000);
    expect(FakeEventSource.instances).toHaveLength(1);
    expect(onReconnecting).not.toHaveBeenCalled();
    handle.close();
  });

  it("C9: a dropped envelope field is a violation too, not a tolerated frame", () => {
    // events.py flattens {type,auditId,timestamp,seq} onto EVERY payload, so a
    // frame missing one is drift. The fold dedups by `seq`; a frame without one
    // would defeat the replay guard entirely.
    const onEvent = vi.fn();
    const onContractViolation = vi.fn();
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent, onContractViolation },
      { eventSource: Ctor, backoffMs: () => 0 },
    );
    FakeEventSource.latest().emit(
      "audit_started",
      frame({ type: "audit_started", packageName: "chalk" }), // no auditId/timestamp/seq
    );
    expect(onEvent).not.toHaveBeenCalled();
    expect(onContractViolation).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it("C9: an audit_error with null fields is rejected, not defaulted", () => {
    // The engine cannot emit this frame (all three fields required non-null, every
    // emit site supplies them). Accepting it and substituting "The audit failed"
    // turns a contract break into a plausible-looking error message, so it is
    // refused by name.
    const onEvent = vi.fn();
    const onContractViolation = vi.fn();
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent, onContractViolation },
      { eventSource: Ctor, backoffMs: () => 0 },
    );
    FakeEventSource.latest().emit(
      "audit_error",
      auditFrame({ type: "audit_error", error: null, code: null, retryable: null }),
    );
    expect(onEvent).not.toHaveBeenCalled();
    expect(onContractViolation).toHaveBeenCalledTimes(1);
    handle.close();
  });

  it("C9: a well-formed frame for every subscribed name is delivered, so C9 is not vacuous", () => {
    // Guards the opposite failure: a validator so strict that nothing passes would
    // satisfy every assertion above. One real frame per name must still arrive.
    const onEvent = vi.fn();
    const onContractViolation = vi.fn();
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent, onContractViolation },
      { eventSource: Ctor, backoffMs: () => 0 },
    );
    const src = FakeEventSource.latest();
    src.emit("phase_started", auditFrame({ type: "phase_started", phase: "flag" }, 1));
    src.emit(
      "verdict_reached",
      auditFrame(
        {
          type: "verdict_reached",
          verdict: "SAFE",
          rationale: "all refuted",
          counts: { total: 0, open: 0, inProgress: 0, confirmed: 0, refuted: 0, deferred: 0 },
          confirmedCount: 0,
        },
        2,
      ),
    );
    expect(onContractViolation).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(2);
    handle.close();
  });
});

/**
 * Unit: connectScanStream (the audit-set progress client) — sse.ts.
 *
 * ONE stream for every origin after R-1: an owned-repo scan and a public-repo
 * audit are the same entity, so this client follows both. It is the mirror image
 * of the audit stream in FRAMING: UNNAMED default messages (onmessage, never
 * named listeners). It is NOT the mirror image in resumability — frames carry an
 * `id:` line, so EventSource's own retry resumes from the cursor; what this client
 * has no loop for is a HARD error, which closes and fires onError so the caller
 * does a full reload. The terminal {type:"done"} is delivered to onMessage.
 *
 * Input classes:
 *  S1  unnamed-message parse — a well-formed default frame is JSON-parsed to a
 *                              ScanStreamFrame and handed to onMessage; no named
 *                              listeners are registered. The dep frame carries the
 *                              WHOLE contract item under `item`, not a flattened
 *                              subset — a flattened frame silently drops direct /
 *                              range / auditedAt / cached.
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
    const item = {
      name: "chalk",
      version: "5.0.0",
      direct: true,
      range: "^5.0.0",
      outcome: "SAFE",
      verdictReason: "clean",
      evidenceCount: 0,
      auditedAt: "2026-07-25T00:00:00.000Z",
      jobState: null,
      cached: true,
    };
    deliver(src, frame({ type: "dep", item }));
    expect(onMessage).toHaveBeenCalledWith({ type: "dep", item });
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

describe("connectAuditStream — C10 reconnect carries the cursor", () => {
  it("C10: a reopen resumes from the highest delivered seq, not from the start", () => {
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent: () => {} },
      { eventSource: Ctor, backoffMs: () => 1000 },
    );
    // The first connection asks for everything — there is nothing to resume from.
    expect(FakeEventSource.latest().url).toBe("/api/audit/a/events");

    FakeEventSource.latest().emit("phase_started", auditFrame({ type: "phase_started", phase: "flag" }, 7));
    FakeEventSource.latest().fail();
    vi.advanceTimersByTime(1000);

    // Closing the source to control the retry discards the browser's own
    // Last-Event-ID, so the cursor has to be explicit or the engine replays
    // every frame again.
    expect(FakeEventSource.latest().url).toBe("/api/audit/a/events?since=7");
    handle.close();
  });

  it("C10b: the cursor only ever moves forward", () => {
    const handle = connectAuditStream(
      "/api/audit/a/events",
      { onEvent: () => {} },
      { eventSource: Ctor, backoffMs: () => 1000 },
    );
    const src = FakeEventSource.latest();
    src.emit("phase_started", auditFrame({ type: "phase_started", phase: "flag" }, 9));
    // A replayed lower seq must not rewind the resume point.
    src.emit("phase_started", auditFrame({ type: "phase_started", phase: "intent" }, 3));
    src.fail();
    vi.advanceTimersByTime(1000);
    expect(FakeEventSource.latest().url).toBe("/api/audit/a/events?since=9");
    handle.close();
  });
});
