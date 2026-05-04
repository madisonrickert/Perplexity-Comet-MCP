import { describe, it, expect } from "vitest";
import { CometAI, pollUntil } from "../../src/comet-ai.js";
import { FakeCdpClient } from "./fakes/fake-cdp-client.js";

// `isResponseStable` only tracks responses longer than 50 characters
// (short responses never stabilize). Use long strings in assertions.
const ANSWER_A = "A".repeat(60);
const ANSWER_B = "B".repeat(60);

describe("pollUntil", () => {
  it("returns true immediately when the predicate is true on first call", async () => {
    let calls = 0;
    const result = await pollUntil(
      async () => {
        calls++;
        return true;
      },
      { maxMs: 1000, intervalMs: 5 },
    );
    expect(result).toBe(true);
    expect(calls).toBe(1);
  });

  it("returns true once a delayed predicate flips to true", async () => {
    let calls = 0;
    const result = await pollUntil(
      async () => {
        calls++;
        return calls >= 3;
      },
      { maxMs: 1000, intervalMs: 5 },
    );
    expect(result).toBe(true);
    expect(calls).toBe(3);
  });

  it("returns false when the predicate never becomes true within maxMs", async () => {
    const result = await pollUntil(async () => false, { maxMs: 60, intervalMs: 10 });
    expect(result).toBe(false);
  });

  it("propagates predicate errors to the caller", async () => {
    await expect(
      pollUntil(async () => {
        throw new Error("transport gone");
      }, { maxMs: 100, intervalMs: 5 }),
    ).rejects.toThrow("transport gone");
  });

  it("respects an injected `now` so deadline comparisons can be deterministic", async () => {
    let virtual = 0;
    let calls = 0;
    const result = await pollUntil(
      async () => {
        calls++;
        virtual += 100; // each call advances simulated time by 100ms
        return false;
      },
      { maxMs: 250, intervalMs: 1, now: () => virtual },
    );
    expect(result).toBe(false);
    // virtual time crosses the 250ms deadline on the third call (0 → 100 → 200 → 300).
    expect(calls).toBe(3);
  });
});

describe("CometAI.isResponseStable", () => {
  it("returns false on the first observation of any response", () => {
    const ai = new CometAI(new FakeCdpClient());
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
  });

  it("returns true on the third identical observation (threshold = 2)", () => {
    const ai = new CometAI(new FakeCdpClient());
    // Call 1: records the text, counter stays 0
    // Call 2: same text, counter increments to 1 → still below threshold
    // Call 3: same text, counter increments to 2 → meets threshold
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
    expect(ai.isResponseStable(ANSWER_A)).toBe(true);
  });

  it("resets the stable counter when the response text changes", () => {
    const ai = new CometAI(new FakeCdpClient());
    ai.isResponseStable(ANSWER_A);
    ai.isResponseStable(ANSWER_A);
    expect(ai.isResponseStable(ANSWER_A)).toBe(true); // stable

    // Different text resets the counter
    expect(ai.isResponseStable(ANSWER_B)).toBe(false);
    expect(ai.isResponseStable(ANSWER_B)).toBe(false);
    expect(ai.isResponseStable(ANSWER_B)).toBe(true); // stable again
  });

  it("stabilizes short non-empty responses after the same threshold", () => {
    const ai = new CometAI(new FakeCdpClient());
    expect(ai.isResponseStable("short")).toBe(false);
    expect(ai.isResponseStable("short")).toBe(false);
    expect(ai.isResponseStable("short")).toBe(true);
  });

  it("returns false for empty responses regardless of repetition", () => {
    const ai = new CometAI(new FakeCdpClient());
    expect(ai.isResponseStable("")).toBe(false);
    expect(ai.isResponseStable("")).toBe(false);
    expect(ai.isResponseStable("")).toBe(false);
  });
});

describe("CometAI.resetStabilityTracking", () => {
  it("zeros the stable counter after a stable response", () => {
    const ai = new CometAI(new FakeCdpClient());
    ai.isResponseStable(ANSWER_A);
    ai.isResponseStable(ANSWER_A);
    expect(ai.isResponseStable(ANSWER_A)).toBe(true);

    ai.resetStabilityTracking();

    // After reset, the same response needs the full sequence again
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
    expect(ai.isResponseStable(ANSWER_A)).toBe(false);
    expect(ai.isResponseStable(ANSWER_A)).toBe(true);
  });
});

describe("CometAI.getAgentStatus", () => {
  it("returns the parsed shape from a canned safeEvaluate result", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      status: "completed",
      steps: ["Searching for X", "Reading results"],
      currentStep: "Reading results",
      response: "the agent's final answer",
      hasStopButton: false,
    });

    const ai = new CometAI(fake);
    const status = await ai.getAgentStatus();

    expect(status.status).toBe("completed");
    expect(status.steps).toEqual(["Searching for X", "Reading results"]);
    expect(status.currentStep).toBe("Reading results");
    expect(status.response).toBe("the agent's final answer");
    expect(status.hasStopButton).toBe(false);
    expect(status.agentBrowsingUrl).toBe("");
    expect(typeof status.isStable).toBe("boolean");
  });

  it("includes the agent-browsing URL when listTabsCategorized returns one", async () => {
    const fake = new FakeCdpClient();
    fake.setTabsResult({
      agentBrowsing: {
        id: "tab-1",
        type: "page",
        title: "Whole Foods",
        url: "https://amazon.com/alm/storefront",
      },
    });
    fake.setEvaluateResult({
      status: "working",
      steps: [],
      currentStep: "",
      response: "",
      hasStopButton: true,
    });

    const ai = new CometAI(fake);
    const status = await ai.getAgentStatus();

    expect(status.agentBrowsingUrl).toBe("https://amazon.com/alm/storefront");
    expect(status.status).toBe("working");
    expect(status.hasStopButton).toBe(true);
  });

  it("ships a stringified IIFE of extractAgentStatus to safeEvaluate", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      status: "idle",
      steps: [],
      currentStep: "",
      response: "",
      hasStopButton: false,
    });

    const ai = new CometAI(fake);
    await ai.getAgentStatus();

    expect(fake.evaluateCalls.length).toBe(1);
    const js = fake.evaluateCalls[0];
    expect(js).toContain("function extractAgentStatus");
    // The IIFE now passes an options object so extractAgentStatus can read
    // the prose watermark. Default to 0 when no watermark is supplied.
    expect(js).toMatch(/\)\(\{"proseWatermark":\s*0\}\)$/);
  });

  it("forwards proseWatermark into the page-eval IIFE", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      status: "idle",
      steps: [],
      currentStep: "",
      response: "",
      hasStopButton: false,
    });

    const ai = new CometAI(fake);
    await ai.getAgentStatus({ proseWatermark: 5 });

    const js = fake.evaluateCalls[0];
    expect(js).toMatch(/\)\(\{"proseWatermark":\s*5\}\)$/);
  });
});

describe("CometAI.getAgentStatus skipped propagation", () => {
  it("propagates a skipped status from the page-side result", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      status: "skipped",
      steps: [],
      currentStep: "",
      response: "",
      hasStopButton: false,
      skippedReason: "answer_skipped",
      skippedMessage: "The agent skipped this task.",
    });

    const ai = new CometAI(fake);
    const status = await ai.getAgentStatus();

    expect(status.status).toBe("skipped");
    expect(status.skippedReason).toBe("answer_skipped");
    expect(status.skippedMessage).toMatch(/skip/i);
  });

  it("does NOT override skipped to completed via the stability heuristic", async () => {
    // Skipped is a terminal failure mode — even if the response text has
    // stabilized (for example, partial output that the agent never resumed),
    // we must not promote it to "completed" or the caller would think the
    // task succeeded.
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      status: "skipped",
      steps: [],
      currentStep: "",
      response: "Partial answer that never finished.",
      hasStopButton: false,
      skippedReason: "answer_skipped",
      skippedMessage: "The agent skipped this task.",
    });

    const ai = new CometAI(fake);
    // Burn enough polls to make the response "stable" by the heuristic.
    await ai.getAgentStatus();
    await ai.getAgentStatus();
    const status = await ai.getAgentStatus();

    expect(status.status).toBe("skipped");
    expect(status.isStable).toBe(true);
  });
});

describe("CometAI.getBrowserBlockState", () => {
  it("propagates a canned login_required block-state from safeEvaluate", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      blocked: true,
      blockedReason: "login_required",
      blockedMessage: "Comet browser automation is unavailable because the browser is logged out. Sign in to unlock full capabilities.",
    });

    const ai = new CometAI(fake);
    const state = await ai.getBrowserBlockState();

    expect(state.blocked).toBe(true);
    expect(state.blockedReason).toBe("login_required");
    expect(state.blockedMessage).toMatch(/logged out|sign in/i);
  });

  it("propagates a quota_exceeded block-state", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({
      blocked: true,
      blockedReason: "quota_exceeded",
      blockedMessage: "Perplexity Pro quota has been reached. Agentic features are unavailable until the quota resets.",
    });

    const ai = new CometAI(fake);
    const state = await ai.getBrowserBlockState();

    expect(state.blocked).toBe(true);
    expect(state.blockedReason).toBe("quota_exceeded");
    expect(state.blockedMessage).toMatch(/quota/i);
  });

  it("returns blocked=false when nothing on the page indicates a block", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult({ blocked: false });

    const ai = new CometAI(fake);
    const state = await ai.getBrowserBlockState();

    expect(state.blocked).toBe(false);
    expect(state.blockedReason).toBeUndefined();
    expect(state.blockedMessage).toBeUndefined();
  });

  it("defensively defaults to {blocked: false} when evaluate returns undefined", async () => {
    const fake = new FakeCdpClient();
    fake.setEvaluateResult(undefined);

    const ai = new CometAI(fake);
    const state = await ai.getBrowserBlockState();

    expect(state.blocked).toBe(false);
  });
});
