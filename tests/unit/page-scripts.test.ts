// @vitest-environment jsdom

import { describe, it, expect, beforeEach } from "vitest";
import { readProseState, extractAgentStatus } from "../../src/page-scripts.js";

beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * jsdom does not compute layout, so `offsetParent` is always `null`.
 * `extractAgentStatus` uses `offsetParent !== null` as a visibility check
 * for stop buttons. To exercise the "working" path we have to mark
 * specific elements as visible.
 */
function markVisible(el: HTMLElement): void {
  Object.defineProperty(el, "offsetParent", {
    configurable: true,
    get() {
      return el.parentElement || document.body;
    },
  });
}

describe("readProseState", () => {
  it("returns count=0 and empty lastText for an empty DOM", () => {
    const state = readProseState();
    expect(state).toEqual({ count: 0, lastText: "" });
  });

  it("returns the count and full lastText (under 100 chars) for one prose block", () => {
    document.body.innerHTML = `<div class="prose">Short answer here.</div>`;
    const state = readProseState();
    expect(state.count).toBe(1);
    expect(state.lastText).toBe("Short answer here.");
  });

  it("returns the last prose block's text when several are present", () => {
    document.body.innerHTML = `
      <div class="prose">first</div>
      <div class="prose-md">middle</div>
      <div class="prose">last block</div>
    `;
    const state = readProseState();
    expect(state.count).toBe(3);
    expect(state.lastText).toBe("last block");
  });

  it("truncates lastText at 100 characters", () => {
    const longText = "x".repeat(250);
    document.body.innerHTML = `<div class="prose">${longText}</div>`;
    const state = readProseState();
    expect(state.count).toBe(1);
    expect(state.lastText.length).toBe(100);
    expect(state.lastText).toBe("x".repeat(100));
  });
});

describe("extractAgentStatus", () => {
  it("returns 'working' when a visible stop button is present", () => {
    document.body.innerHTML = `<button aria-label="Stop">stop</button>`;
    const btn = document.querySelector("button") as HTMLButtonElement;
    markVisible(btn);

    const result = extractAgentStatus();
    expect(result.status).toBe("working");
    expect(result.hasStopButton).toBe(true);
  });

  it("returns 'completed' when 'Reviewed N sources' is present, prose has content, no stop button", () => {
    document.body.innerHTML = `
      <main>
        <div>Reviewed 12 sources</div>
        <div class="prose">This is the agent's final answer with enough length to clear the threshold for prose detection in the extractor.</div>
        <button aria-label="New chat">New</button>
      </main>
    `;

    const result = extractAgentStatus();
    expect(result.status).toBe("completed");
    expect(result.hasStopButton).toBe(false);
    expect(result.response.length).toBeGreaterThan(0);
  });

  it("extracts and dedupes step descriptions matching the working patterns", () => {
    // Pattern matching runs against document.body.innerText.
    // Use one step per <div> so jsdom's innerText emits one per line.
    document.body.innerHTML = `
      <div>Searching for vegan ingredients</div>
      <div>Reading product details</div>
      <div>Searching for vegan ingredients</div>
      <div>Navigating to checkout</div>
    `;

    const result = extractAgentStatus();
    // After Set-dedupe, three unique steps remain.
    expect(result.steps.length).toBe(3);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        "Searching for vegan ingredients",
        "Reading product details",
        "Navigating to checkout",
      ])
    );
    // currentStep should be the most recently matched step.
    expect(result.currentStep).toMatch(/Searching for|Reading|Navigating/);
  });
});

describe("extractAgentStatus stop-button refinement", () => {
  it("ignores buttons whose aria-label matches a dismiss/login keyword", () => {
    // A button with both 'stop' and 'login' in its aria-label is a sign-in
    // dismiss button, NOT an agent stop button. The exclusion list
    // (close/dismiss/sign/login/modal) means we should skip it.
    document.body.innerHTML = `<button aria-label="Close login modal">×</button>`;
    const btn = document.querySelector("button") as HTMLButtonElement;
    markVisible(btn);

    const result = extractAgentStatus();
    expect(result.hasStopButton).toBe(false);
  });

  it("does not flag a non-square rect as a stop indicator", () => {
    // The stop-button square-rect detection requires width ≈ height (within 4px).
    // A 10×20 rect is clearly not square — it shouldn't promote the button to a stop.
    document.body.innerHTML = `
      <button aria-label="some-action">
        <svg><rect width="10" height="20"></rect></svg>
      </button>`;
    const btn = document.querySelector("button") as HTMLButtonElement;
    markVisible(btn);

    const result = extractAgentStatus();
    expect(result.hasStopButton).toBe(false);
  });

  it("flags a button with a square rect (width ≈ height) as a stop indicator", () => {
    document.body.innerHTML = `
      <button aria-label="some-action">
        <svg><rect width="20" height="20"></rect></svg>
      </button>`;
    const btn = document.querySelector("button") as HTMLButtonElement;
    markVisible(btn);

    const result = extractAgentStatus();
    expect(result.hasStopButton).toBe(true);
    expect(result.status).toBe("working");
  });
});

describe("extractAgentStatus prose-first response extraction", () => {
  it("strips inline citation chip text from the prose response", () => {
    document.body.innerHTML = `
      <main>
        <div class="prose">
          <p>Photosynthesis converts light energy into chemical energy<span class="citation inline">+1</span>.</p>
        </div>
      </main>
    `;

    const result = extractAgentStatus();
    expect(result.response).not.toContain("+1");
    expect(result.response).toContain("Photosynthesis converts light energy into chemical energy");
  });

  it("strips multiple chip-like descendants (anchors, buttons, citation spans)", () => {
    document.body.innerHTML = `
      <main>
        <div class="prose">
          <p>Plants use chlorophyll<a href="#x">stackoverflow</a> to absorb light<button>copy</button> for ATP synthesis<span class="source">nodejs</span>.</p>
        </div>
      </main>
    `;

    const result = extractAgentStatus();
    expect(result.response).not.toContain("stackoverflow");
    expect(result.response).not.toContain("copy");
    expect(result.response).not.toContain("nodejs");
    expect(result.response).toContain("Plants use chlorophyll");
    expect(result.response).toContain("ATP synthesis");
  });

  it("falls back to bodyText marker extraction when no prose container exists", () => {
    // No <div class="prose"> — Strategy 1 finds nothing, Strategy 2 (marker-based) takes over.
    document.body.innerHTML = `
      <main>
        <p>3 steps completed</p>
        <p>The answer to your question is forty-two.</p>
        <p>Ask a follow-up</p>
      </main>
    `;

    const result = extractAgentStatus();
    expect(result.response).toContain("forty-two");
    expect(result.response).not.toContain("Ask a follow-up");
  });
});
