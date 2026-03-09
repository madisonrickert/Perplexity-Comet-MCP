// Page-side scripts that run inside the Perplexity tab via CDP `evaluate`.
//
// Each function uses only browser globals (document, etc.) — never Node
// imports — so the same function body can run in two contexts:
//
//   - production: `cometClient.evaluate(\`(${fn.toString()})()\`)` ships the
//     function body into the page and returns its result through CDP
//   - tests: imported and called natively in vitest's jsdom env
//
// One source of truth, type-checked by TypeScript, exercised by unit tests.
// Do not add closure references or imports beyond DOM APIs — the
// stringified form would break.

export interface ProseState {
  count: number;
  lastText: string;
}

export function readProseState(): ProseState {
  const proseEls = document.querySelectorAll('[class*="prose"]');
  const lastProse = proseEls[proseEls.length - 1] as HTMLElement | undefined;
  return {
    count: proseEls.length,
    lastText: lastProse ? lastProse.innerText.substring(0, 100) : "",
  };
}

export interface AgentStatusResult {
  status: "idle" | "working" | "completed" | "blocked";
  steps: string[];
  currentStep: string;
  response: string;
  hasStopButton: boolean;
  /** Reason browser automation is blocked, e.g. "login_required". `undefined` if unblocked. */
  blockedReason?: "login_required";
  /** Human-readable explanation of the blocked state. `undefined` if unblocked. */
  blockedMessage?: string;
  /** False when Comet's browser automation is unavailable (logged out, etc.). */
  browserAutomationAvailable: boolean;
}

export function extractAgentStatus(): AgentStatusResult {
  const body = document.body.innerText;

  // Stop-button detection. Excludes modal dismiss/login buttons and requires
  // a square `<rect>` (width ≈ height) for SVG-based stop indicators, which
  // avoids false positives from non-square icons.
  let hasActiveStopButton = false;
  for (const btn of document.querySelectorAll("button")) {
    const ariaLabel = (btn.getAttribute("aria-label") || "").toLowerCase();
    const btnText = btn.innerText.toLowerCase();

    if ((btn as HTMLButtonElement).offsetParent === null || (btn as HTMLButtonElement).disabled) continue;

    const isDismissButton =
      ariaLabel.includes("close") ||
      ariaLabel.includes("dismiss") ||
      ariaLabel.includes("sign") ||
      ariaLabel.includes("login") ||
      ariaLabel.includes("modal");

    if (isDismissButton) continue;

    const rectEl = btn.querySelector("rect");
    const isSquareRect =
      rectEl &&
      Math.abs(
        parseFloat(rectEl.getAttribute("width") || "0") -
          parseFloat(rectEl.getAttribute("height") || "0")
      ) < 4;

    const isStopButton =
      ariaLabel.includes("stop") ||
      ariaLabel.includes("cancel") ||
      btnText === "stop" ||
      isSquareRect;

    if (isStopButton) {
      hasActiveStopButton = true;
      break;
    }
  }

  // Loading spinner detection scoped to exclude sidebar/modal/banner regions
  // and zero-size elements, which previously caused status to hang in 'working'.
  const hasLoadingSpinner = (() => {
    const spinners = document.querySelectorAll(
      '[class*="animate-spin"],[class*="animate-pulse"],[class*="loading"],[class*="thinking"]'
    );
    for (const el of spinners) {
      if (el.closest('nav,aside,header,[role="dialog"],[role="banner"],[aria-modal]')) continue;
      if (el.closest('[class*="sidebar"],[class*="modal"],[class*="overlay"],[class*="dialog"]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      return true;
    }
    return false;
  })();

  // "Thinking" indicator (avoid matching "Thinking about" which is unrelated text)
  const hasThinkingIndicator = body.includes("Thinking") && !body.includes("Thinking about");

  const hasStepsCompleted = /\d+ steps? completed/i.test(body);
  const hasFinishedMarker = body.includes("Finished") && !hasActiveStopButton;
  const hasReviewedSources = /Reviewed \d+ sources?/i.test(body);
  const hasSourcesIndicator = /\d+\s*sources?/i.test(body); // "10 sources" etc
  const hasAskFollowUp = body.includes("Ask a follow-up") || body.includes("Ask follow-up");

  // Detect Comet's "logged out, can't browse" / login-wall states. These show
  // up either as inline body text or as a visible login dialog. When detected,
  // we return status='blocked' so the caller can surface a clear error
  // instead of timing out.
  const hasLoggedOutBrowserText = body.includes("Comet Assistant can't use the browser when logged out");
  const hasUnlockCapabilitiesText = body.includes("Log in to unlock full capabilities");
  const hasSignInAccountText = body.includes("Sign in or create an account");
  const hasVisibleLoginDialog = [
    ...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog'),
  ].some((el) => {
    if (!(el instanceof HTMLElement) || el.offsetParent === null) return false;
    const text = (el.textContent || "").toLowerCase();
    return (
      text.includes("sign in") ||
      text.includes("log in") ||
      text.includes("create an account") ||
      text.includes("continue with google") ||
      text.includes("continue with apple")
    );
  });
  const browserAutomationBlocked =
    hasLoggedOutBrowserText ||
    ((hasUnlockCapabilitiesText || hasSignInAccountText) && hasVisibleLoginDialog);
  const blockedReason: "login_required" | undefined = browserAutomationBlocked
    ? "login_required"
    : undefined;
  const blockedMessage: string | undefined = browserAutomationBlocked
    ? "Comet browser automation is unavailable because the browser is logged out. Sign in to unlock full capabilities."
    : undefined;

  // Prose-content threshold lowered to >0 so short answers (e.g. "2 + 2 = 4.")
  // are detected. Sidebar/UI text is filtered out by prefix.
  const proseEls = [...document.querySelectorAll('[class*="prose"]')] as HTMLElement[];
  const hasProseContent = proseEls.some((el) => {
    const text = el.innerText.trim();
    return (
      text.length > 0 &&
      !text.startsWith("Library") &&
      !text.startsWith("Discover") &&
      !text.startsWith("Spaces") &&
      !text.startsWith("Finance") &&
      !text.startsWith("Search")
    );
  });

  const workingPatterns = [
    "Working", "Searching", "Reviewing sources", "Preparing to assist",
    "Clicking", "Typing:", "Navigating to", "Reading", "Analyzing",
    "Browsing", "Looking at", "Checking", "Opening", "Scrolling",
    "Waiting", "Processing",
  ];
  const hasWorkingText = workingPatterns.some((p) => body.includes(p));

  // Status determination. Blocked beats everything: if the browser is logged
  // out, no other detection is meaningful. Otherwise AskFollowUp+Prose ranks
  // above LoadingSpinner because a visible follow-up prompt with prose is a
  // stronger completion signal than a stale spinner sitting somewhere on the page.
  let status: "idle" | "working" | "completed" | "blocked" = "idle";

  if (browserAutomationBlocked) {
    status = "blocked";
  } else if (hasActiveStopButton) {
    status = "working";
  } else if (hasAskFollowUp && hasProseContent) {
    status = "completed";
  } else if (hasStepsCompleted || hasFinishedMarker) {
    status = "completed";
  } else if (hasLoadingSpinner || hasThinkingIndicator) {
    status = "working";
  } else if (hasSourcesIndicator && hasProseContent && !hasActiveStopButton) {
    status = "completed";
  } else if (hasReviewedSources && !hasActiveStopButton) {
    status = "completed";
  } else if (hasWorkingText) {
    status = "working";
  }

  // Extract steps
  const steps: string[] = [];
  const stepPatterns = [
    /Preparing to assist[^\n]*/g, /Clicking[^\n]*/g, /Typing:[^\n]*/g,
    /Navigating[^\n]*/g, /Reading[^\n]*/g, /Searching[^\n]*/g, /Found[^\n]*/g,
  ];
  for (const pattern of stepPatterns) {
    const matches = body.match(pattern);
    if (matches) steps.push(...matches.map((s) => s.trim().substring(0, 100)));
  }

  // Response extraction runs unconditionally so idle-timeout and stability paths
  // in the polling loop see the latest text even before status flips to completed.
  let response = "";
  {
    const mainContent = (document.querySelector("main") || document.body) as HTMLElement;
    const bodyText = mainContent.innerText;

    // Strategy 1: Find content after "X steps completed" marker (agent's final response)
    const stepsMatch = bodyText.match(/(\d+)\s*steps?\s*completed/i);
    if (stepsMatch) {
      const markerIndex = bodyText.indexOf(stepsMatch[0]);
      if (markerIndex !== -1) {
        let afterMarker = bodyText.substring(markerIndex + stepsMatch[0].length).trim();
        afterMarker = afterMarker.replace(/^[>›→\s]+/, "").trim();
        const endMarkers = ["Ask anything", "Ask a follow-up", "Add details", "Type a message"];
        let endIndex = afterMarker.length;
        for (const marker of endMarkers) {
          const idx = afterMarker.indexOf(marker);
          if (idx !== -1 && idx < endIndex) endIndex = idx;
        }
        response = afterMarker.substring(0, endIndex).trim();
      }
    }

    // Strategy 2: If no steps marker, look for content after source citations
    if (!response || response.length < 1) {
      const sourcesMatch = bodyText.match(/Reviewed\s+\d+\s+sources?/i);
      if (sourcesMatch) {
        const markerIndex = bodyText.indexOf(sourcesMatch[0]);
        if (markerIndex !== -1) {
          let afterMarker = bodyText.substring(markerIndex + sourcesMatch[0].length).trim();
          const endMarkers = ["Ask anything", "Ask a follow-up", "Add details"];
          let endIndex = afterMarker.length;
          for (const marker of endMarkers) {
            const idx = afterMarker.indexOf(marker);
            if (idx !== -1 && idx < endIndex) endIndex = idx;
          }
          response = afterMarker.substring(0, endIndex).trim();
        }
      }
    }

    // Strategy 3: Fallback - get all prose content combined
    if (!response || response.length < 1) {
      const allProseEls = [...mainContent.querySelectorAll('[class*="prose"]')] as HTMLElement[];
      const validTexts = allProseEls
        .filter((el) => {
          if (el.closest("nav, aside, header, footer, form, [contenteditable]")) return false;
          const text = el.innerText.trim();
          const isUIText = ["Library", "Discover", "Spaces", "Finance", "Account",
                            "Upgrade", "Home", "Search"].some((ui) => text.startsWith(ui));
          return !isUIText && text.length > 0;
        })
        .map((el) => el.innerText.trim());

      if (validTexts.length > 0) {
        response = validTexts.slice(-3).join("\n\n");
      }
    }
  }

  if (response) {
    response = response
      .replace(/View All/gi, "")
      .replace(/Show more/gi, "")
      .replace(/Ask a follow-up/gi, "")
      .replace(/Ask anything\.*/gi, "")
      .replace(/Add details to this task\.*/gi, "")
      .replace(/\d+\s*sources?\s*$/gi, "")
      .replace(/[\u{1F300}-\u{1F9FF}]/gu, "")
      .replace(/^[>›→\s]+/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return {
    status,
    steps: [...new Set(steps)].slice(-5),
    currentStep: steps.length > 0 ? steps[steps.length - 1] : "",
    response: response.substring(0, 8000),
    hasStopButton: hasActiveStopButton,
    blockedReason,
    blockedMessage,
    browserAutomationAvailable: !browserAutomationBlocked,
  };
}
