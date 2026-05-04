import { describe, it, expect, vi } from "vitest";
import {
  createProgressEmitter,
  formatProgressMessage,
  type ProgressNotification,
} from "../../src/streaming.js";

describe("createProgressEmitter", () => {
  it("returns null when the client did not supply a progressToken", () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    expect(createProgressEmitter(undefined, sendNotification)).toBeNull();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("returns null for an explicitly nullish token (treated as not requested)", () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    // @ts-expect-error — exercise the runtime guard against null tokens.
    expect(createProgressEmitter(null, sendNotification)).toBeNull();
  });

  it("emits a notifications/progress message that pins the supplied token", async () => {
    const sent: ProgressNotification[] = [];
    const sendNotification = vi.fn(async (n: ProgressNotification) => {
      sent.push(n);
    });

    const emitter = createProgressEmitter("tok-abc", sendNotification);
    expect(emitter).not.toBeNull();

    await emitter!.emit({ progress: 1, message: "first poll" });
    await emitter!.emit({ progress: 2, total: 10, message: "second poll" });

    expect(sent.length).toBe(2);
    expect(sent[0].method).toBe("notifications/progress");
    expect(sent[0].params.progressToken).toBe("tok-abc");
    expect(sent[0].params.progress).toBe(1);
    expect(sent[0].params.message).toBe("first poll");
    expect(sent[0].params.total).toBeUndefined();

    expect(sent[1].params.total).toBe(10);
  });

  it("supports numeric progress tokens (per JSON-RPC spec)", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const emitter = createProgressEmitter(42, sendNotification);
    await emitter!.emit({ progress: 1 });

    expect(sendNotification).toHaveBeenCalledOnce();
    const sent = sendNotification.mock.calls[0][0] as ProgressNotification;
    expect(sent.params.progressToken).toBe(42);
  });

  it("swallows transport errors so a failed notification does not abort the tool call", async () => {
    const sendNotification = vi.fn().mockRejectedValue(new Error("transport gone"));
    const emitter = createProgressEmitter("tok", sendNotification);

    // Must not throw — primary tool result is more important than any single
    // progress update, and the transport may transiently fail.
    await expect(emitter!.emit({ progress: 1, message: "trying" })).resolves.toBeUndefined();
  });

  it("omits message and total when the caller doesn't supply them", async () => {
    const sendNotification = vi.fn().mockResolvedValue(undefined);
    const emitter = createProgressEmitter("tok", sendNotification);
    await emitter!.emit({ progress: 1 });

    const sent = sendNotification.mock.calls[0][0] as ProgressNotification;
    expect(sent.params.progress).toBe(1);
    expect(sent.params.message).toBeUndefined();
    expect(sent.params.total).toBeUndefined();
  });
});

describe("formatProgressMessage", () => {
  it("includes only the status when no other fields are populated", () => {
    expect(formatProgressMessage({ status: "working" })).toBe("Status: WORKING");
  });

  it("includes the current step when provided", () => {
    const message = formatProgressMessage({
      status: "working",
      currentStep: "Reading product details",
    });
    expect(message).toBe("Status: WORKING | Step: Reading product details");
  });

  it("includes the agent-browsing URL when provided", () => {
    const message = formatProgressMessage({
      status: "working",
      currentStep: "Searching",
      agentBrowsingUrl: "https://example.com/page",
    });
    expect(message).toContain("Browsing: https://example.com/page");
  });

  it("truncates long partial responses to keep notifications small", () => {
    const longResponse = "a".repeat(5000);
    const message = formatProgressMessage({
      status: "working",
      response: longResponse,
    });
    expect(message).toContain("Partial:");
    expect(message).toContain("…");
    // Notifications must stay compact; the full response is delivered in
    // the final tool result, not duplicated here.
    expect(message.length).toBeLessThan(500);
  });

  it("does not include a Partial: section when there is no response yet", () => {
    const message = formatProgressMessage({ status: "working", currentStep: "Searching" });
    expect(message).not.toContain("Partial:");
  });

  it("collapses whitespace inside the partial-response snippet", () => {
    const message = formatProgressMessage({
      status: "working",
      response: "Line one\n\n\nline two\twith\ttabs",
    });
    expect(message).toContain("Partial: Line one line two with tabs");
  });
});
