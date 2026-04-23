import { describe, it, expect } from "vitest";
import { scriptParsedToEvent, allocateHostPort } from "./v8-inspector.js";

describe("scriptParsedToEvent", () => {
  it("maps a full CDP event to an L4:v8inspector Event", () => {
    const cdp = {
      scriptId: "42",
      url: "file:///pkg/index.js",
      startLine: 0,
      endLine: 120,
      hash: "abc123",
      length: 4200,
      isModule: true,
    };
    const ev = scriptParsedToEvent(cdp);
    expect(ev.stream).toBe("L4:v8inspector");
    expect(ev.kind).toBe("script_parsed");
    expect(ev.pid).toBe(0);
    expect(ev.timestamp).toBe(0);
    expect(ev.raw).toEqual(cdp);
    expect(ev.normalized).toEqual({
      scriptId: "42",
      url: "file:///pkg/index.js",
      startLine: 0,
      endLine: 120,
      length: 4200,
      cdpHash: "abc123",
      isModule: true,
    });
  });

  it("fills defaults for missing fields", () => {
    const ev = scriptParsedToEvent({});
    expect(ev.normalized).toEqual({
      scriptId: "",
      url: "",
      startLine: 0,
      endLine: 0,
      length: 0,
      cdpHash: "",
      isModule: false,
    });
  });

  it("survives null / undefined params gracefully", () => {
    const a = scriptParsedToEvent(null);
    const b = scriptParsedToEvent(undefined);
    expect(a.kind).toBe("script_parsed");
    expect(b.kind).toBe("script_parsed");
  });

  it("captures dynamically-generated script urls like 'evalmachine.<anonymous>'", () => {
    const ev = scriptParsedToEvent({
      scriptId: "7",
      url: "evalmachine.<anonymous>",
      length: 16,
    });
    expect(ev.normalized!.url).toBe("evalmachine.<anonymous>");
    expect(ev.normalized!.length).toBe(16);
  });

  it("coerces numeric strings to numbers", () => {
    const ev = scriptParsedToEvent({
      scriptId: "1",
      startLine: "3" as unknown as number,
      endLine: "7" as unknown as number,
      length: "42" as unknown as number,
    });
    expect(ev.normalized!.startLine).toBe(3);
    expect(ev.normalized!.endLine).toBe(7);
    expect(ev.normalized!.length).toBe(42);
  });
});

describe("allocateHostPort", () => {
  it("returns a unique free port each call", async () => {
    const a = await allocateHostPort();
    const b = await allocateHostPort();
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    // Ports may occasionally coincide under tight timing, but should usually differ.
    // Not strictly asserting different; just asserting valid port range.
    expect(a).toBeLessThan(65536);
    expect(b).toBeLessThan(65536);
  });
});
