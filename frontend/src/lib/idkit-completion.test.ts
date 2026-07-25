import { describe, expect, it } from "vitest";
import { readCompletion } from "./idkit-completion.ts";

/** A realistic IDKitResultV4, as World App returns it through the bridge. */
const RESULT_V4 = {
  protocol_version: "4.0",
  nonce: "0x2f1c…",
  action: "attest-npm-release",
  user_presence_completed: true,
  environment: "staging",
  responses: [
    {
      identifier: "proof_of_human",
      signal_hash: "0x00ab",
      proof: ["0x1", "0x2", "0x3", "0x4", "0x5"],
      nullifier: "0xdead",
      issuer_schema_id: 1,
      expires_at_min: 1790000000,
    },
  ],
};

describe("readCompletion", () => {
  it("unwraps the proof out of the {success, result} envelope", () => {
    const outcome = readCompletion({ success: true, result: RESULT_V4 });
    expect(outcome).toEqual({ kind: "proof", proof: RESULT_V4 });
  });

  it("never forwards the envelope itself — that is what World rejects", () => {
    // The regression this file exists for. `pollUntilCompletion()` resolves to
    // a wrapper; posting the wrapper makes World's /verify answer
    // `validation_error`, because it wants IDKitResult's fields at top level.
    const outcome = readCompletion({ success: true, result: RESULT_V4 });
    if (outcome.kind !== "proof") throw new Error("expected a proof");
    expect(outcome.proof).not.toHaveProperty("success");
    expect(outcome.proof).not.toHaveProperty("result");
    expect(outcome.proof).toHaveProperty("protocol_version", "4.0");
    expect(outcome.proof).toHaveProperty("responses");
  });

  it("reports a user cancellation as cancelled, not as a rejected proof", () => {
    const outcome = readCompletion({ success: false, error: "user_rejected" });
    expect(outcome.kind).toBe("cancelled");
    if (outcome.kind !== "cancelled") return;
    expect(outcome.code).toBe("user_rejected");
    expect(outcome.message).toMatch(/cancel/i);
  });

  it("explains a failed presence check in the operator's terms", () => {
    const outcome = readCompletion({ success: false, error: "user_presence_failed" });
    if (outcome.kind !== "cancelled") throw new Error("expected cancelled");
    expect(outcome.message).toMatch(/presence/i);
  });

  it("carries an unmapped error code through rather than swallowing it", () => {
    const outcome = readCompletion({ success: false, error: "something_new" });
    if (outcome.kind !== "cancelled") throw new Error("expected cancelled");
    expect(outcome.code).toBe("something_new");
    expect(outcome.message).toContain("something_new");
  });

  it.each([null, undefined, "nope", 42, {}, { success: true }, { success: true, result: 7 }])(
    "treats %p as malformed instead of posting it",
    (input) => {
      expect(readCompletion(input).kind).toBe("malformed");
    },
  );
});
