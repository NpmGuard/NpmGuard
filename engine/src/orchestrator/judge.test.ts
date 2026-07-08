import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hypothesis } from "@npmguard/shared";
import type { RenderedTimeline } from "../evidence/timeline.js";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("../llm.js", () => ({ getModel: vi.fn(() => "model") }));

import { generateObject } from "ai";
import { getModel } from "../llm.js";
import { judgeEvidence, type JudgeVerdict } from "./judge.js";

const generateObjectMock = vi.mocked(generateObject);
const getModelMock = vi.mocked(getModel);

function hyp(): Hypothesis {
  return {
    hypId: "h1",
    description: "reads ~/.npmrc and posts it to an undocumented host",
    claim: { kind: "env_exfil", gating: null },
    focusFiles: ["setup.js"],
    focusLines: [{ file: "setup.js", range: "1-40" }],
    severity: "high",
    parentHypId: null,
    childHypIds: [],
    state: "IN_PROGRESS",
    createdBy: "triage",
    evidenceRefs: [],
    createdAt: "2026-07-08T00:00:00.000Z",
    resolvedAt: null,
    resolution: null,
  };
}

const timeline: RenderedTimeline = {
  text: "e1 read ~/.npmrc\ne2 net POST https://evil.example",
  ids: new Set(["e1", "e2"]),
};

function mockVerdict(v: JudgeVerdict) {
  generateObjectMock.mockResolvedValue({ object: v } as unknown as Awaited<ReturnType<typeof generateObject>>);
}

beforeEach(() => {
  generateObjectMock.mockReset();
  getModelMock.mockReset().mockReturnValue("model" as unknown as ReturnType<typeof getModel>);
});

describe("judgeEvidence — confirm mapping", () => {
  it("(6) malicious=true with ≥1 real cited id → confirmed=true", async () => {
    mockVerdict({ malicious: true, reason: "exfil", citedEvents: ["e1", "e2"] });
    const r = await judgeEvidence(hyp(), timeline, "a config loader");
    expect(r.confirmed).toBe(true);
    expect(r.citedEvents).toEqual(["e1", "e2"]);
    expect(r.judgeFailed).toBe(false);
  });

  it("(7) malicious=true but citedEvents=[] → confirmed=false", async () => {
    mockVerdict({ malicious: true, reason: "sure but no evidence", citedEvents: [] });
    const r = await judgeEvidence(hyp(), timeline, "a config loader");
    expect(r.confirmed).toBe(false);
  });

  it("(8) malicious=true citing an id absent from the timeline → confirmed=false", async () => {
    mockVerdict({ malicious: true, reason: "hallucinated", citedEvents: ["e99"] });
    const r = await judgeEvidence(hyp(), timeline, "a config loader");
    expect(r.confirmed).toBe(false);
    expect(r.citedEvents).toEqual([]); // phantom id dropped
  });

  it("(9) malicious=false → confirmed=false", async () => {
    mockVerdict({ malicious: false, reason: "benign", citedEvents: [] });
    const r = await judgeEvidence(hyp(), timeline, "a config loader");
    expect(r.confirmed).toBe(false);
  });

  it("keeps only the real ids when the model mixes real + phantom citations", async () => {
    mockVerdict({ malicious: true, reason: "mostly real", citedEvents: ["e1", "e99"] });
    const r = await judgeEvidence(hyp(), timeline, "a config loader");
    expect(r.confirmed).toBe(true);
    expect(r.citedEvents).toEqual(["e1"]);
  });

  it("a judge model failure yields a non-confirming result, not a throw", async () => {
    getModelMock.mockImplementation(() => {
      throw new Error("model backend unavailable");
    });
    const r = await judgeEvidence(hyp(), timeline, "a config loader");
    expect(r.confirmed).toBe(false);
    expect(r.judgeFailed).toBe(true);
    expect(r.reason).toContain("Judge model call failed");
  });
});
